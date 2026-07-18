package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
)

// Client is a thin API client that transparently refreshes the device access
// token on 401 responses.
type Client struct {
	cfg  *Config
	http *http.Client
}

func NewClient(cfg *Config) *Client {
	return &Client{cfg: cfg, http: &http.Client{Timeout: 30 * time.Second}}
}

func (c *Client) base() string { return strings.TrimRight(c.cfg.ServerURL, "/") }

// Enroll registers the device and stores the returned credentials.
func (c *Client) Enroll(info DeviceInfo) (*EnrollResponse, error) {
	body, _ := json.Marshal(EnrollRequest{
		EnrollmentToken: c.cfg.EnrollmentToken,
		Info:            info,
		Display:         &c.cfg.Display,
	})
	resp, err := c.http.Post(c.base()+"/api/enroll", "application/json", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		b, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("enroll failed: %s %s", resp.Status, string(b))
	}
	out := &EnrollResponse{}
	if err := json.NewDecoder(resp.Body).Decode(out); err != nil {
		return nil, err
	}
	return out, nil
}

func (c *Client) refresh() error {
	body, _ := json.Marshal(map[string]string{
		"device_uuid":   c.cfg.DeviceUUID,
		"refresh_token": c.cfg.RefreshToken,
	})
	resp, err := c.http.Post(c.base()+"/api/token/refresh", "application/json", bytes.NewReader(body))
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return fmt.Errorf("refresh failed: %s", resp.Status)
	}
	var out struct {
		AccessToken string `json:"access_token"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return err
	}
	c.cfg.AccessToken = out.AccessToken
	return c.cfg.Save()
}

// do performs an authenticated request, refreshing the token once on 401.
func (c *Client) do(method, path string, contentType string, body []byte) (*http.Response, error) {
	attempt := func() (*http.Response, error) {
		var r io.Reader
		if body != nil {
			r = bytes.NewReader(body)
		}
		req, err := http.NewRequest(method, c.base()+path, r)
		if err != nil {
			return nil, err
		}
		req.Header.Set("Authorization", "Bearer "+c.cfg.AccessToken)
		if contentType != "" {
			req.Header.Set("Content-Type", contentType)
		}
		return c.http.Do(req)
	}
	resp, err := attempt()
	if err != nil {
		return nil, err
	}
	if resp.StatusCode == 401 {
		resp.Body.Close()
		if err := c.refresh(); err != nil {
			return nil, err
		}
		return attempt()
	}
	return resp, nil
}

func (c *Client) PostHealth(h HealthSample) error {
	body, _ := json.Marshal(h)
	resp, err := c.do("POST", "/api/agent/health", "application/json", body)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return fmt.Errorf("health post: %s", resp.Status)
	}
	return nil
}

// PostResolution updates display information after the X11 session is ready.
func (c *Client) PostResolution(resolution string) error {
	if resolution == "" {
		return nil
	}
	body, _ := json.Marshal(map[string]string{"resolution": resolution})
	resp, err := c.do("POST", "/api/agent/display-info", "application/json", body)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return fmt.Errorf("display info post: %s", resp.Status)
	}
	return nil
}

// PostDeviceInfo refreshes the device-page fields that can change after
// enrollment, such as IP address and Agent version.
func (c *Client) PostDeviceInfo(info DeviceInfo) error {
	body, _ := json.Marshal(info)
	resp, err := c.do("POST", "/api/agent/info", "application/json", body)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return fmt.Errorf("device info post: %s", resp.Status)
	}
	return nil
}

// GetTarget fetches the single effective scene or scene-group playback target.
func (c *Client) GetTarget() (*ResolvedTarget, error) {
	resp, err := c.do("GET", "/api/agent/target", "", nil)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("target: %s", resp.Status)
	}
	out := &ResolvedTarget{}
	if err := json.NewDecoder(resp.Body).Decode(out); err != nil {
		return nil, err
	}
	return out, nil
}

func (c *Client) PostScreenshot(png []byte, trigger, analysis string) error {
	path := "/api/agent/screenshot?trigger=" + trigger
	if analysis != "" {
		path += "&analysis=" + analysis
	}
	resp, err := c.do("POST", path, "image/png", png)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return fmt.Errorf("screenshot: %s", resp.Status)
	}
	return nil
}

func (c *Client) CheckUpdate(current string) (*OtaUpdate, error) {
	path := fmt.Sprintf("/api/agent/update?channel=%s&current=%s", c.cfg.Channel, current)
	resp, err := c.do("GET", path, "", nil)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("update check: %s", resp.Status)
	}
	out := &OtaUpdate{}
	if err := json.NewDecoder(resp.Body).Decode(out); err != nil {
		return nil, err
	}
	return out, nil
}

// DownloadTo streams an authenticated download (media / OTA) to a file.
func (c *Client) DownloadTo(url, dest string) error {
	// url is absolute; append the access token so <img>/binary endpoints accept it.
	sep := "?"
	if strings.Contains(url, "?") {
		sep = "&"
	}
	req, err := http.NewRequest("GET", url+sep+"token="+c.cfg.AccessToken, nil)
	if err != nil {
		return err
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return errors.New("download status " + resp.Status)
	}
	f, err := os.Create(dest)
	if err != nil {
		return err
	}
	defer f.Close()
	_, err = io.Copy(f, resp.Body)
	return err
}
