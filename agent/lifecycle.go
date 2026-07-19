package main

import (
	"context"
	"sync"
	"time"
)

// loopSet owns the agent's periodic background jobs. Replacing a job cancels
// only that job; Chromium and the command connection keep running.
type loopSet struct {
	mu      sync.Mutex
	ctx     context.Context
	cancels map[string]context.CancelFunc
	wg      *sync.WaitGroup
}

func newLoopSet(ctx context.Context, wg *sync.WaitGroup) *loopSet {
	return &loopSet{ctx: ctx, cancels: map[string]context.CancelFunc{}, wg: wg}
}

func (s *loopSet) replace(name string, initial, every time.Duration, fn func()) {
	s.mu.Lock()
	if cancel := s.cancels[name]; cancel != nil {
		cancel()
	}
	ctx, cancel := context.WithCancel(s.ctx)
	s.cancels[name] = cancel
	s.mu.Unlock()

	if every <= 0 {
		return
	}
	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		if initial > 0 {
			t := time.NewTimer(initial)
			defer t.Stop()
			select {
			case <-ctx.Done():
				return
			case <-t.C:
			}
		}
		fn()
		ticker := time.NewTicker(every)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				fn()
			}
		}
	}()
}

func (s *loopSet) stop() {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, cancel := range s.cancels {
		cancel()
	}
	s.cancels = map[string]context.CancelFunc{}
}
