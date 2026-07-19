package main

import (
	"fmt"
	"log"
	"os"
	"os/exec"
	"sync"
	"time"
)

// browserProcess is the minimal control surface the supervisor needs over a
// launched kiosk browser. *exec.Cmd is adapted to it in production; tests supply
// a deterministic fake so the supervision logic can be exercised without X11.
type browserProcess interface {
	Pid() int
	Wait() error // blocks until the process exits
	Kill() error // force-terminates the process
}

// execProcess adapts *exec.Cmd to browserProcess.
type execProcess struct{ cmd *exec.Cmd }

func (e *execProcess) Pid() int {
	if e.cmd.Process == nil {
		return 0
	}
	return e.cmd.Process.Pid
}

func (e *execProcess) Wait() error { return e.cmd.Wait() }

func (e *execProcess) Kill() error {
	if e.cmd.Process == nil {
		return nil
	}
	return e.cmd.Process.Kill()
}

// Browser lifecycle states, surfaced in health as chromium_status.
const (
	browserStarting = "starting"
	browserRunning  = "running"
	browserCrashed  = "crashed" // past the consecutive-failure cap; still retrying at max backoff
	browserStopped  = "stopped"
)

// BrowserStatus is a snapshot of the supervised browser for health reporting.
type BrowserStatus struct {
	State        string
	PID          int
	RestartCount int // unexpected relaunches (crash recoveries) since start
	LastExitAt   time.Time
	LastExitErr  string
	Healthy      bool
}

type exitEvent struct {
	gen int
	err error
}

// Browser supervises a single kiosk browser process. It reaps every child with
// Wait(), tells an operator-requested relaunch apart from an unexpected crash,
// relaunches crashes with exponential backoff up to a failure cap, and exposes a
// status snapshot for health. Exactly one supervise goroutine mutates lifecycle
// state; callers interact through channels, so no two browsers ever race.
type Browser struct {
	launch     func() (browserProcess, error)
	backoffMin time.Duration
	backoffMax time.Duration
	failCap    int           // consecutive failures at which the state flips to crashed
	healthyFor time.Duration // uptime after which a run is deemed healthy, resetting the count

	restartCh chan chan struct{} // operator relaunch requests; the reply is closed once accepted
	exitCh    chan exitEvent
	stopCh    chan struct{}
	stopOnce  sync.Once
	done      chan struct{}
	procWG    sync.WaitGroup

	mu     sync.Mutex
	cur    browserProcess
	status BrowserStatus

	// test hook: invoked (best-effort) after each successful launch with its gen.
	onLaunch func(gen int)
}

// NewBrowser builds a supervisor that launches Chromium from cfg. preLaunch, if
// set, runs immediately before every (re)launch — used to reapply display
// rotation so a relaunched browser honours the current orientation.
func NewBrowser(cfg *Config, preLaunch func()) *Browser {
	b := newBrowserSupervisor(func() (browserProcess, error) {
		if preLaunch != nil {
			preLaunch()
		}
		return launchChromium(cfg)
	})
	return b
}

// newBrowserSupervisor wires a supervisor around an injected launcher. Tests use
// it directly with a fake launcher and tiny backoff.
func newBrowserSupervisor(launch func() (browserProcess, error)) *Browser {
	return &Browser{
		launch:     launch,
		backoffMin: time.Second,
		backoffMax: 30 * time.Second,
		failCap:    5,
		healthyFor: 60 * time.Second,
		restartCh:  make(chan chan struct{}),
		exitCh:     make(chan exitEvent),
		stopCh:     make(chan struct{}),
		done:       make(chan struct{}),
		status:     BrowserStatus{State: browserStarting},
	}
}

// Start launches the browser and begins supervising it in the background.
func (b *Browser) Start() { go b.supervise() }

// Relaunch requests an operator-initiated restart and blocks until the
// supervisor accepts it. An operator restart is never counted as a crash.
func (b *Browser) Relaunch() {
	reply := make(chan struct{})
	select {
	case b.restartCh <- reply:
		<-reply
	case <-b.stopCh:
	}
}

// Stop terminates the current browser and ends supervision. Safe to call once;
// further calls are no-ops.
func (b *Browser) Stop() {
	b.stopOnce.Do(func() { close(b.stopCh) })
	<-b.done
}

// Status returns a snapshot of the supervised browser for health reporting.
func (b *Browser) Status() BrowserStatus {
	b.mu.Lock()
	defer b.mu.Unlock()
	s := b.status
	if b.cur != nil {
		s.PID = b.cur.Pid()
	}
	return s
}

func (b *Browser) supervise() {
	defer func() {
		b.procWG.Wait() // every killed Chromium has completed Wait() before shutdown returns
		close(b.done)
	}()
	gen := 0
	failures := 0
	for {
		gen++
		proc, err := b.launch()
		if err != nil {
			failures++
			log.Printf("browser: launch failed (attempt %d): %v", failures, err)
			b.mu.Lock()
			b.status.State = browserCrashed
			b.status.Healthy = false
			b.status.LastExitAt = time.Now()
			b.status.LastExitErr = err.Error()
			b.mu.Unlock()
			if !b.sleepBackoff(failures) {
				return
			}
			continue
		}

		b.mu.Lock()
		b.cur = proc
		b.status.PID = proc.Pid()
		if failures >= b.failCap {
			b.status.State = browserCrashed // relaunching, but flagged unhealthy
			b.status.Healthy = false
		} else {
			b.status.State = browserRunning
			b.status.Healthy = true
		}
		b.status.LastExitErr = ""
		b.mu.Unlock()
		log.Printf("browser: launched pid %d (gen %d)", proc.Pid(), gen)
		if b.onLaunch != nil {
			b.onLaunch(gen)
		}
		startedAt := time.Now()

		// Watch this specific generation. Tagging the event with gen lets the
		// supervisor ignore a late exit from a browser it has already replaced.
		b.procWG.Add(1)
		go func(g int, p browserProcess) {
			defer b.procWG.Done()
			werr := p.Wait()
			select {
			case b.exitCh <- exitEvent{gen: g, err: werr}:
			case <-b.stopCh:
			}
		}(gen, proc)

		expected, stopped := b.awaitTransition(gen)
		if stopped {
			return
		}

		now := time.Now()
		b.mu.Lock()
		b.cur = nil
		b.status.PID = 0
		b.status.LastExitAt = now
		if err != nil {
			b.status.LastExitErr = err.Error()
		}
		b.mu.Unlock()

		if expected {
			// Operator relaunch: reset escalation and relaunch immediately.
			failures = 0
			continue
		}

		// Unexpected crash. A crash after a long healthy run starts a fresh
		// escalation rather than inheriting a stale high backoff.
		if now.Sub(startedAt) >= b.healthyFor {
			failures = 1
		} else {
			failures++
		}
		b.mu.Lock()
		b.status.RestartCount++
		b.status.Healthy = false
		if failures >= b.failCap {
			b.status.State = browserCrashed
		} else {
			b.status.State = browserStarting
		}
		b.mu.Unlock()
		log.Printf("browser: exited unexpectedly (failure %d), relaunching", failures)
		if !b.sleepBackoff(failures) {
			return
		}
	}
}

// awaitTransition blocks until the current generation crashes, an operator
// relaunch arrives, or the supervisor is stopped. It returns (expected, stopped).
// A late exit tagged with a superseded generation is ignored, so an old process
// dying can never disturb the browser that replaced it.
func (b *Browser) awaitTransition(gen int) (expected, stopped bool) {
	for {
		select {
		case ev := <-b.exitCh:
			if ev.gen != gen {
				continue // stale exit from an already-replaced browser
			}
			if ev.err != nil {
				b.mu.Lock()
				b.status.LastExitErr = ev.err.Error()
				b.mu.Unlock()
			}
			return false, false
		case reply := <-b.restartCh:
			b.mu.Lock()
			cur := b.cur
			b.mu.Unlock()
			if cur != nil {
				_ = cur.Kill()
			}
			close(reply)
			// Do not launch another Chromium until this child has really exited
			// and its Wait goroutine has reaped it. Chromium uses a shared
			// user-data-dir, so starting early can otherwise produce a profile
			// lock error (and leaves a short-lived zombie behind).
			for {
				select {
				case ev := <-b.exitCh:
					if ev.gen == gen {
						return true, false
					}
				case extraReply := <-b.restartCh:
					// The requested restart is already in progress; acknowledge
					// duplicate requests without scheduling another generation.
					close(extraReply)
				case <-b.stopCh:
					return false, true
				}
			}
		case <-b.stopCh:
			b.mu.Lock()
			if b.cur != nil {
				_ = b.cur.Kill()
			}
			b.status.State = browserStopped
			b.status.Healthy = false
			b.mu.Unlock()
			return false, true
		}
	}
}

// sleepBackoff waits before the next relaunch, cutting the wait short if an
// operator relaunch or stop arrives. It returns false only when stopped.
func (b *Browser) sleepBackoff(failures int) bool {
	d := backoffFor(failures, b.backoffMin, b.backoffMax)
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-t.C:
		return true
	case reply := <-b.restartCh:
		close(reply) // operator asked to restart during backoff: proceed now
		return true
	case <-b.stopCh:
		return false
	}
}

// backoffFor returns the delay before the Nth consecutive relaunch attempt,
// doubling from min and capped at max. failures is 1-based (1 => min).
func backoffFor(failures int, min, max time.Duration) time.Duration {
	if failures <= 1 {
		return min
	}
	d := min
	for i := 1; i < failures; i++ {
		d *= 2
		if d >= max {
			return max
		}
	}
	return d
}

// launchChromium starts the kiosk browser with the current display settings.
func launchChromium(cfg *Config) (browserProcess, error) {
	target := fmt.Sprintf("http://127.0.0.1:%d/", cfg.PlayerPort)
	args := []string{
		"--noerrdialogs",
		"--disable-infobars",
		"--disable-session-crashed-bubble",
		"--disable-translate",
		"--incognito",
		"--user-data-dir=/tmp/screenboard-chromium",
		// Paint the pre-first-paint surface black instead of Chromium's default
		// white, so a cold (re)launch does not flash white before player.html's
		// black background renders. Value is ARGB hex (opaque black).
		"--default-background-color=FF000000",
		fmt.Sprintf("--force-device-scale-factor=%.2f", cfg.Display.Zoom),
	}
	if cfg.Display.Kiosk {
		args = append(args, "--kiosk")
	}
	args = append(args, "--app="+target)

	cmd := exec.Command(cfg.ChromiumBin, args...)
	cmd.Env = append(os.Environ(), "DISPLAY=:0")
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	log.Printf("chromium launched: %s", target)
	return &execProcess{cmd: cmd}, nil
}
