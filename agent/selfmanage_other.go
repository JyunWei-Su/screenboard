//go:build !linux

package main

import "syscall"

// detachAttr is a no-op on non-Linux builds (the agent only ships on Linux); it
// keeps the package compiling so unit tests run on any developer OS.
func detachAttr() *syscall.SysProcAttr { return nil }
