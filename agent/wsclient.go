package main

import (
	"encoding/json"
	"log"
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// CommandHandler processes a server command and reports success + detail.
type CommandHandler func(cmd ServerCommand) (ok bool, detail string)

// WSClient maintains the persistent command channel with auto-reconnect.
type WSClient struct {
	cfg     *Config
	client  *Client
	handler CommandHandler

	mu   sync.Mutex
	conn *websocket.Conn
}

func NewWSClient(cfg *Config, client *Client, handler CommandHandler) *WSClient {
	return &WSClient{cfg: cfg, client: client, handler: handler}
}

// Run connects and blocks, reconnecting with backoff until the process exits.
func (w *WSClient) Run() {
	backoff := time.Second
	for {
		if err := w.connectAndServe(); err != nil {
			log.Printf("ws: %v (retry in %s)", err, backoff)
			time.Sleep(backoff)
			if backoff < 30*time.Second {
				backoff *= 2
			}
			continue
		}
		backoff = time.Second
	}
}

func (w *WSClient) connectAndServe() error {
	url := w.cfg.WSURL + "?token=" + w.cfg.AccessToken
	conn, resp, err := websocket.DefaultDialer.Dial(url, nil)
	if err != nil {
		if resp != nil && resp.StatusCode == http.StatusUnauthorized {
			if rErr := w.client.refresh(); rErr == nil {
				url = w.cfg.WSURL + "?token=" + w.cfg.AccessToken
				conn, _, err = websocket.DefaultDialer.Dial(url, nil)
			}
		}
		if err != nil {
			return err
		}
	}
	w.mu.Lock()
	w.conn = conn
	w.mu.Unlock()
	log.Printf("ws connected")

	// Heartbeat keeps the DO presence fresh.
	stop := make(chan struct{})
	go w.heartbeat(stop)
	defer close(stop)
	defer conn.Close()

	for {
		_, data, err := conn.ReadMessage()
		if err != nil {
			return err
		}
		w.dispatch(data)
	}
}

func (w *WSClient) heartbeat(stop <-chan struct{}) {
	t := time.NewTicker(30 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-stop:
			return
		case <-t.C:
			_ = w.send(Heartbeat{Type: "heartbeat"})
		}
	}
}

func (w *WSClient) dispatch(data []byte) {
	// Ignore server "welcome"; act on commands.
	var probe struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(data, &probe); err == nil && probe.Type == "welcome" {
		return
	}
	var cmd ServerCommand
	if err := json.Unmarshal(data, &cmd); err != nil || cmd.ID == "" {
		return
	}
	ok, detail := w.handler(cmd)
	_ = w.send(CommandAck{Type: "ack", CommandID: cmd.ID, OK: ok, Detail: detail})
}

func (w *WSClient) send(v interface{}) error {
	w.mu.Lock()
	conn := w.conn
	w.mu.Unlock()
	if conn == nil {
		return nil
	}
	b, _ := json.Marshal(v)
	return conn.WriteMessage(websocket.TextMessage, b)
}

// SendPlayback relays a player event over the channel (best-effort).
func (w *WSClient) SendPlayback(ev PlaybackEvent) { _ = w.send(ev) }
