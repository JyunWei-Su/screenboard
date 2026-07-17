# TODO — 瀏覽器 SSH:改用 Cloudflare Access for Infrastructure

## 目標
讓管理員「在瀏覽器打開裝置的 SSH 網址 → OTP 登入 → 直接得到終端機」,免裝 client、免管理 SSH 金鑰。
取代目前的 self-hosted + 公開 hostname 方案(瀏覽器打開只會**全白**,因為 self-hosted app 不 render SSH 終端機)。

## 背景 / 為什麼
- 現況 `provisionRemoteAccess`([apps/api/src/lib/cloudflareTunnel.ts](apps/api/src/lib/cloudflareTunnel.ts))建的是 `type: self_hosted` 的 Access app,tunnel ingress 為 `ssh://localhost:22`。
- 用瀏覽器打開 `https://ssh-<uuid>.<zone>` → Access 驗證後把 HTTP 請求轉給 SSH 埠 → 沒有 HTTP 內容 → **空白**。Cloudflare 的瀏覽器 SSH 終端機現在只走 **Access for Infrastructure**。
- 額外缺口:install.sh 只設了 sshd(僅 pubkey、關密碼),**沒裝 authorized_keys 也沒信任任何 SSH CA** → 就算終端機 render 出來也無憑證可登入。

## 已確認的前提(API 探測結果)
- [x] `GET /accounts/{acct}/infrastructure/targets` → **200**(帳號**支援** Access for Infrastructure)
- [x] `GET /accounts/{acct}/access/gateway_ca` → **404 `gateway_ca_not_found`**(SSH CA 尚未建立,可 POST 建立)
- [x] `GET /accounts/{acct}/access/organizations` → **200**(Zero Trust org 存在)
- [x] `CF_API_TOKEN` 已擴權含 Zero Trust(Access / Infrastructure / SSH CA)——**執行期 API 佈建也需要這些權限**

---

## A. Cloudflare 帳號一次性設定(SSH 短期憑證 CA)
- [ ] 建立帳號層 SSH CA:`POST /accounts/{acct}/access/gateway_ca`,保存回傳的 **CA 公鑰**
- [ ] 決定 CA 公鑰的取得方式:install.sh 由裝置端向 API 拉(新增 device-facing 端點),避免把 CA 寫死在腳本
- [ ] 確認 CA 是帳號單一還是每 app —— 目前假設**帳號單一**,所有裝置共用

## B. API — 重寫 `provisionRemoteAccess`(cloudflareTunnel.ts)
- [ ] 保留:建立 per-device cfd_tunnel + DNS/連接;**移除**公開 `ssh://` 的 self_hosted app 建法
- [ ] 建立 **infrastructure Target**:`POST /accounts/{acct}/infrastructure/targets`
      `{ hostname, ip: { ipv4: { ip_addr } } }`(hostname=邏輯名;ip=連接器可達的裝置位址)
- [ ] tunnel 改成**私有網路路由**到 target（warp routing / private route，取代公開 hostname ingress）
      ⚠️ 需驗證:cloudflared 跑在裝置本機時,target IP 用 127.0.0.1 還是裝置 LAN IP、路由怎麼設
- [ ] 建立 `type: "infrastructure"` 的 Access app:
      `target_criteria: [{ target_attributes: { hostname: [<target>] }, protocol: "SSH", port: 22 }]`
- [ ] 建立 policy:`decision: "allow"`、`include: [emails]`(沿用 `CF_ACCESS_ALLOWED_EMAILS`)、
      `connection_rules: { ssh: { usernames: [<允許的 Linux 使用者>] } }`
- [ ] 決定**允許登入的使用者名稱**清單(見「待決定」)
- [ ] ⚠️ 對照實際 Cloudflare API 逐一驗證欄位形狀(target / infra app / policy connection_rules),邊做邊修

## C. API — 狀態 / DB / 端點
- [ ] `device_remote_access` schema:視需要新增欄位(target_id、app 類型、CA 版本);沿用 `provisioning_version` 做遷移判斷(bump 到 3)
- [ ] `getTunnelStatus` / `GET /:uuid/remote-access`([apps/api/src/routes/devices.ts](apps/api/src/routes/devices.ts)):回傳新的瀏覽器終端機網址與狀態
- [ ] `removeRemoteAccess`:一併刪除 target 與 infra app(避免遺留)
- [ ] device-facing 端點:提供 SSH CA 公鑰給 install.sh / `repair_tunnel` 取用

## D. 裝置端 — install.sh
- [ ] 建立可登入的 SSH 使用者(login shell);決定用既有 kiosk 使用者或新增專用帳號(如 `sbadmin`)
- [ ] 抓 Cloudflare SSH CA 公鑰 → 寫入 `/etc/ssh/screenboard_ca.pub`
- [ ] sshd 設定:`TrustedUserCAKeys /etc/ssh/screenboard_ca.pub` + principals 設定(讓憑證 principal 對應到允許帳號),重啟 sshd
- [ ] 確認 cloudflared 私有網路路由設定(若需在裝置端額外設定)
- [ ] 把上述整合進既有 `screenboard-repair-tunnel` helper,讓**遠端修復**也能重建 infra 連線

## E. 管理台(admin)
- [ ] [DeviceDetail.tsx](apps/admin/src/pages/DeviceDetail.tsx):「開啟 SSH 終端機」連結改指向 **Infra app 的瀏覽器終端機網址**(非 `https://<hostname>`)
      ⚠️ 需確認正確的終端機 URL 形式(團隊網域 app launcher / 每-app 網址)
- [ ] remote-access 狀態顯示配合新模型調整文案

## F. 遷移 / 上線
- [ ] 為既有裝置提供遷移:reprovision(建 target/infra app)→ 一次 reinstall(裝 CA 信任、sshd 設定)
- [ ] `needs_reprovision` 判斷納入新的 provisioning_version
- [ ] 舊的 self_hosted app / 公開 hostname ingress 清除
- [ ] 打包新 agent(若 `repair_tunnel` helper 有改)→ OTA + 一次 reinstall
- [ ] 更新 [DEPLOY.md](DEPLOY.md) / [README.md](README.md) 的 SSH 說明

## G. 驗證
- [ ] 瀏覽器打開裝置 SSH 網址 → OTP 登入 → **出現終端機** → 選使用者 → 成功登入
- [ ] 未授權 email 被擋
- [ ] `infrastructure/targets` 出現該裝置;Access log 有 SSH 連線紀錄
- [ ] 遠端按「修復 SSH 連線」可重建;刪除裝置會清掉 target/app/DNS/tunnel

---

## 待決定(需要人決定)
- [ ] **允許登入的 Linux 使用者**:kiosk 使用者?還是新增 `sbadmin`?權限到哪(sudo?)
- [ ] SSH CA 由誰/何時建立(首次佈建自動 POST,或部署腳本一次性建立)
- [ ] 是否啟用 **SSH 指令記錄 / session 稽核**(Access for Infrastructure 支援)
- [ ] 是否保留 client 方式(`cloudflared access ssh`)作為備援

## 風險 / 注意
- Cloudflare Infra API 部分欄位形狀需對實際 API 驗證(target 路由、connection_rules、終端機 URL)。
- 會**取代**目前(空白但已連線)的 tunnel 設定,需重佈建 + 一次 reinstall,期間 SSH 會中斷。
- 私有網路路由 + 裝置本機 cloudflared 的 target IP/路由是最需要先做 PoC 的一環。

## 參考
- 端點:`/accounts/{acct}/infrastructure/targets`、`/accounts/{acct}/access/apps`(type=infrastructure)、
  `/accounts/{acct}/access/gateway_ca`、policy `connection_rules.ssh`
- 主要檔案:[cloudflareTunnel.ts](apps/api/src/lib/cloudflareTunnel.ts)、[routes/devices.ts](apps/api/src/routes/devices.ts)、
  [routes/agent.ts](apps/api/src/routes/agent.ts)、[install.sh](apps/api/src/install.sh)、[DeviceDetail.tsx](apps/admin/src/pages/DeviceDetail.tsx)
- Cloudflare 文件主題:Access for Infrastructure、SSH with short-lived certificates、Infrastructure targets
