# TODO — Cloudflare 瀏覽器 SSH 終端機

## 目標

從 ScreenBoard 的裝置詳情頁開啟 Cloudflare 提供的 **browser-rendered SSH terminal**。操作者只需要瀏覽器與 Cloudflare Access 登入，不需要安裝 WARP、`cloudflared` 或本機 SSH client。

> 這是「在網頁中操作 SSH」：管理台的按鈕開啟每台裝置的 Cloudflare SSH 終端機。它不是將第三方終端 iframe 嵌入到 ScreenBoard 頁面中。

## 已確認的正確架構

```
ScreenBoard 管理台
  -> https://ssh-<device-uuid>.<zone>
  -> Cloudflare Access（self-hosted public application + browser-rendered SSH）
  -> Cloudflare Tunnel（ssh://localhost:22）
  -> 裝置上的 sshd
```

- Cloudflare 的 browser-rendered SSH **只支援 self-hosted public application**；不是 Access for Infrastructure 的功能。
- Access for Infrastructure 適用於使用者端有 WARP / Cloudflare One Client 的原生 SSH、細粒度 target policy 與 SSH command logging；它可與此方案共用 Tunnel，但不是本專案的必要條件。
- 瀏覽器 SSH 只能設定在 hostname / subdomain，不能設定在 URL path。

官方文件：

- [Browser-rendered terminal](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/non-http/browser-rendering/)
- [Connect to SSH in the browser](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/use-cases/ssh/ssh-browser-rendering/)
- [Self-hosted app short-lived certificates (legacy)](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/non-http/short-lived-certificates-legacy/)

---

## 現況盤點

### 已完成

- [x] `provisionRemoteAccess` 建立每台裝置專屬的 remotely-managed Cloudflare Tunnel。
- [x] Tunnel ingress 為 `ssh://localhost:22`，並建立一層子網域 `ssh-<uuid>.<zone>`；符合 Universal SSL 的覆蓋範圍。
- [x] 建立 `type: "ssh"` 的 browser SSH Access app、Allow email policy 與 app 專屬 CA。
- [x] 管理台已有 **Open SSH terminal** 按鈕，會開啟該 hostname。
- [x] 安裝程式安裝 `openssh-server`、停用 root 與密碼登入、安裝並啟動每台裝置的 `cloudflared` connector。
- [x] 裝置刪除與重新佈建會清理／重建 Tunnel、DNS 與 Access app。

### 尚未完成／目前會阻塞登入

- [ ] 尚未針對已部署裝置完成重新佈建與 installer 升級；新流程會自動設定 Access app、CA 與 Linux 操作帳號。
- [ ] 尚未驗證已部署的 Access app policy 是否只有 Allow／Block，也尚未以授權與未授權帳號實測。

---

## 實作待辦

### A. Cloudflare Access app 自動佈建

- [ ] 在 Zero Trust 建立或確認可用的 Identity Provider（Email OTP 或既有 IdP）。
- [x] `provisionRemoteAccess` 建立 app 時使用 `type: "ssh"`，自動啟用 browser-rendered SSH；保留 public hostname destination。
- [x] 對既有 `self_hosted` app 以 `provisioning_version` 觸發安全的重新佈建。
- [ ] 確認 app 僅有 Allow／Block policy，且 Allow policy 限制 `CF_ACCESS_ALLOWED_EMAILS` 中的操作者。
- [x] 建立 app 後呼叫 `POST /accounts/{account}/access/apps/{app_id}/ca`，自動產生該 app 的 short-lived certificate CA，保存其 **公開** CA key。
- [ ] 不得把帳號層 `gateway_ca` 當成 browser SSH app 的 CA。

### B. API 與資料模型

- [x] 擴充 `device_remote_access`，保存 app 專屬 CA public key 與升版用 `provisioning_version`。
- [ ] 將現有記錄升版為「需要轉換 `ssh` app type + 安裝 app CA」；管理台顯示明確的遷移狀態，而不是只判斷 hostname。
- [x] 經 device token 驗證的端點會提供自身 Access app 的 **公開** CA key；不會回傳 Cloudflare API token 或任何私密金鑰。
- [ ] `GET /devices/:uuid/remote-access` 回傳可操作狀態：Tunnel、Access app、browser rendering、CA 安裝版本與可開啟的 hostname。
- [ ] 若 `CF_ACCESS_ALLOWED_EMAILS` 為空，讓 API 明確回報設定錯誤；目前雖安全地 default-deny，但會建立無人可登入的 app。

### C. 裝置安裝與修復

- [x] installer 依 `CF_ACCESS_ALLOWED_EMAILS` 建立 email 前綴對應的無 sudo Linux 帳號，不使用 kiosk 帳號。
- [x] 將 device-facing API 的 CA public key 寫入 `/etc/ssh/screenboard_access_ca.pub`，設定安全權限。
- [x] 在 `/etc/ssh/sshd_config.d/50-screenboard.conf` 加入 `TrustedUserCAKeys /etc/ssh/screenboard_access_ca.pub`，並 reload `sshd`。
- [ ] 保持 `PermitRootLogin no`、`PasswordAuthentication no`、`KbdInteractiveAuthentication no`；不要為了 browser terminal 重新開啟密碼登入。
- [ ] 擴充 `screenboard-repair-tunnel` 或新增獨立 helper，使 CA 更新與 sshd reload 可由裝置 command channel 修復；Tunnel 修復與 SSH 認證修復需可分辨。

### D. 管理台與操作流程

- [ ] 保留「Open SSH terminal」新分頁行為；這是 Cloudflare 支援的 clientless terminal 入口。
- [ ] 顯示瀏覽器 SSH readiness：Tunnel healthy、Access policy 已配置、browser rendering 已啟用、裝置 CA 版本相符。
- [ ] 顯示 Access app 類型與 CA readiness；正常流程不需要 Cloudflare Dashboard 的手動設定。
- [ ] 不假設 Cloudflare 的終端機可以安全 iframe 嵌入 ScreenBoard 管理台；若未來需要內嵌，另行評估 CSP／frame-ancestors 與自行實作 xterm.js proxy 的安全性。

### E. 遷移與驗證

- [ ] 對既有裝置：將 self-hosted app 自動轉為 `type: "ssh"`，再更新裝置 CA 與 sshd；不遷移至 Infrastructure app。
- [ ] 以單一測試裝置驗證：
  - [ ] 授權 email：Access 登入後出現終端機，並能以短期憑證登入指定 Linux 帳號。
  - [ ] 未授權 email：在 Access 層被拒絕。
  - [ ] Tunnel 停止：管理台顯示非 healthy，終端不可連線。
  - [ ] CA 不相符：可從 sshd journal 辨識認證失敗，更新 CA 後恢復。
  - [ ] `repair_tunnel`、重新佈建、刪除裝置不會遺留 Tunnel／DNS／Access app。
- [ ] 更新 README、DEPLOY 文件：加入 browser-rendering 與每 app CA 設定，並說明 ScreenBoard TOTP 與 Cloudflare Access 是兩套獨立驗證。

## 非本階段範圍

- Access for Infrastructure、Targets、private network routes、WARP split tunnel、`gateway_ca` 與 SSH command logging。
- SSH 終端 iframe 內嵌到 ScreenBoard admin。

若未來需要「原生 SSH + WARP + 短期憑證 + command logging」，可另建 Access for Infrastructure，並共用現有 Tunnel；不要替換 browser SSH 路線。
