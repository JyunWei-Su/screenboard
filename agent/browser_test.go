package main

import (
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// fakeProc is a controllable stand-in for a launched browser. Wait blocks until
// the test explicitly makes it exit, so supervision can be driven deterministically.
type fakeProc struct {
	pid        int
	exit       chan error
	killed     atomic.Bool
	holdOnKill atomic.Bool
	exitOnce   sync.Once
}

func newFakeProc(pid int) *fakeProc { return &fakeProc{pid: pid, exit: make(chan error, 1)} }

func (f *fakeProc) Pid() int    { return f.pid }
func (f *fakeProc) Wait() error { return <-f.exit }
func (f *fakeProc) Kill() error {
	f.killed.Store(true)
	if !f.holdOnKill.Load() {
		f.die(errors.New("killed"))
	}
	return nil
}
func (f *fakeProc) die(err error) { f.exitOnce.Do(func() { f.exit <- err }) }

// fakeLauncher returns a launcher that hands out fresh fakeProcs and publishes
// each one on procs so the test can drive it.
func fakeLauncher(procs chan *fakeProc) func() (browserProcess, error) {
	var mu sync.Mutex
	pid := 1000
	return func() (browserProcess, error) {
		mu.Lock()
		pid++
		p := newFakeProc(pid)
		mu.Unlock()
		procs <- p
		return p, nil
	}
}

func testSupervisor(launch func() (browserProcess, error)) (*Browser, chan int) {
	b := newBrowserSupervisor(launch)
	b.backoffMin = time.Millisecond
	b.backoffMax = 2 * time.Millisecond
	b.healthyFor = time.Hour // never auto-reset within a test
	launched := make(chan int, 16)
	b.onLaunch = func(gen int) { launched <- gen }
	return b, launched
}

func TestBackoffFor(t *testing.T) {
	min, max := time.Second, 30*time.Second
	cases := []struct {
		n    int
		want time.Duration
	}{
		{0, min}, {1, min}, {2, 2 * time.Second}, {3, 4 * time.Second},
		{4, 8 * time.Second}, {5, 16 * time.Second}, {6, max}, {12, max},
	}
	for _, c := range cases {
		if got := backoffFor(c.n, min, max); got != c.want {
			t.Errorf("backoffFor(%d) = %v, want %v", c.n, got, c.want)
		}
	}
}

// A stale exit from a browser the supervisor has already replaced must never
// trigger a relaunch or disturb the current process.
func TestStaleExitIgnored(t *testing.T) {
	procs := make(chan *fakeProc, 16)
	b, launched := testSupervisor(fakeLauncher(procs))
	b.Start()
	defer b.Stop()

	if g := <-launched; g != 1 {
		t.Fatalf("first launch gen = %d, want 1", g)
	}
	p1 := <-procs
	p1.holdOnKill.Store(true)

	// Operator relaunch kills p1, but must wait for it to exit/reap before gen 2
	// is launched: Chromium shares its user-data-dir between generations.
	relaunchDone := make(chan struct{})
	go func() { b.Relaunch(); close(relaunchDone) }()
	deadline := time.After(time.Second)
	for !p1.killed.Load() {
		select {
		case <-deadline:
			t.Fatal("expected the superseded process to be killed on relaunch")
		default:
			time.Sleep(time.Millisecond)
		}
	}
	select {
	case g := <-launched:
		t.Fatalf("unexpected generation %d before old process was reaped", g)
	default:
	}
	p1.die(errors.New("late exit from replaced browser"))
	<-relaunchDone
	if g := <-launched; g != 2 {
		t.Fatalf("relaunch gen = %d, want 2", g)
	}
	p2 := <-procs

	// A genuine crash of the current (gen 2) process must relaunch to gen 3.
	p2.die(errors.New("boom"))
	if g := <-launched; g != 3 {
		t.Fatalf("post-crash gen = %d, want 3", g)
	}

	// The completed operator restart must not have produced any extra launch.
	select {
	case g := <-launched:
		t.Fatalf("unexpected extra launch (gen %d): stale exit was not ignored", g)
	case <-time.After(60 * time.Millisecond):
	}
	if st := b.Status(); st.RestartCount != 1 {
		t.Fatalf("RestartCount = %d, want 1 (a single real crash)", st.RestartCount)
	}
}

// Operator-requested relaunches are expected stops, never counted as crashes.
func TestOperatorRelaunchNotCountedAsCrash(t *testing.T) {
	procs := make(chan *fakeProc, 16)
	b, launched := testSupervisor(fakeLauncher(procs))
	b.Start()
	defer b.Stop()

	<-launched // gen 1
	<-procs
	for want := 2; want <= 4; want++ {
		b.Relaunch()
		if g := <-launched; g != want {
			t.Fatalf("relaunch gen = %d, want %d", g, want)
		}
		<-procs
	}
	if st := b.Status(); st.RestartCount != 0 {
		t.Fatalf("RestartCount = %d, want 0 (operator relaunches are not crashes)", st.RestartCount)
	}
}

// A crash escalates the failure count and keeps recovering.
func TestCrashRelaunchesAndCounts(t *testing.T) {
	procs := make(chan *fakeProc, 16)
	b, launched := testSupervisor(fakeLauncher(procs))
	b.Start()
	defer b.Stop()

	<-launched // gen 1
	p := <-procs
	for i := 1; i <= 3; i++ {
		p.die(errors.New("crash"))
		if g := <-launched; g != i+1 {
			t.Fatalf("relaunch gen = %d, want %d", g, i+1)
		}
		p = <-procs
	}
	st := b.Status()
	if st.RestartCount != 3 {
		t.Fatalf("RestartCount = %d, want 3", st.RestartCount)
	}
	// Below the failure cap (5) the browser is still considered recovering.
	if !st.Healthy || st.State != browserRunning {
		t.Fatalf("after 3 crashes want healthy/running, got %+v", st)
	}
}
