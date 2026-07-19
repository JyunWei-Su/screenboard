//go:build !linux

package main

// diskUsage is a stub for non-Linux builds (the agent only ships on Linux). It
// exists so the package compiles and its unit tests run on any developer OS.
func diskUsage(string) float64 { return 0 }
