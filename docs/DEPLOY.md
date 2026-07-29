# Triển khai Spendy lên máy Debian 12 (Docker)

Hướng dẫn dựng bản Spendy **server-authoritative**: toàn bộ dữ liệu nằm trong SQLite trên máy
chủ, trình duyệt không còn giữ IndexedDB. Server viết bằng **Python 3.12 thư viện chuẩn**, không
cài thêm gói nào.

> **CẢNH BÁO BẢO MẬT — đọc trước khi làm bất cứ bước nào**
> Ứng dụng **KHÔNG có đăng nhập, không mật khẩu**. Ai vào được cổng 8765 là đọc/sửa/xoá được
> mọi thứ: giao dịch, ảnh hoá đơn, và **số thẻ tín dụng + CVV đang lưu không mã hoá**.
> Chỉ chạy trong mạng LAN nhà mình hoặc qua VPN (Tailscale/WireGuard). **Tuyệt đối không
> NAT / port-forward ra Internet.** Xem mục [Bảo mật](#9-bảo-mật--bắt-buộc-đọc).

---

## 0. Tổng quan kiến trúc triển khai

```
Debian 12 (máy của bạn)
└── /srv/spendy                     ← git clone
    ├── Dockerfile                  → image spendy:local
    ├── docker-compose.yml          → service "spendy", cổng 8765
    └── data/                       ← THƯ MỤC DỮ LIỆU DUY NHẤT ($SPENDY_DATA = /data)
        ├── spendy.db (+ -wal/-shm) ← nguồn sự thật
        ├── images/<hh>/<hash>.<ext>← ảnh đính kèm
        └── tmp/                    ← file restore đang chờ xác nhận
```

Trong image chỉ có: `Spendy.html`, `spendy.js`, `server/`, `vendor/` (Chart.js + PapaParse).
**Không có file dữ liệu nào bị nướng vào image** (xem `.dockerignore`).

Biến môi trường (đặt trong `docker-compose.yml`, ghi đè được bằng file `.env`):

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `SPENDY_DATA` | `/data` | thư mục chứa `spendy.db`, `images/`, `tmp/` |
| `SPENDY_APP_DIR` | `/app` | file tĩnh (`Spendy.html`, `spendy.js`, `vendor/`) |
| `SPENDY_HOST` | `0.0.0.0` | địa chỉ bind **bên trong** container |
| `SPENDY_PORT` | `8765` | cổng |
| `SPENDY_BIND` | `127.0.0.1` | **địa chỉ bind phía host** — quyết định ai thấy được app |
| `SPENDY_UID` / `SPENDY_GID` | `10001` | user chạy container, phải khớp chủ sở hữu `./data` |
| `TZ` | `Asia/Ho_Chi_Minh` | múi giờ cho log/timestamp phía server |

---

## 1. Chuẩn bị (prerequisites)

- Debian 12 (bookworm), tài khoản có `sudo`.
- **Docker Engine + Compose v2**. Gói `docker.io` trong kho Debian 12 quá cũ và **không có lệnh
  `docker compose`**, nên hãy cài bản chính thức:

  ```bash
  curl -fsSL https://get.docker.com | sudo sh
  sudo usermod -aG docker "$USER"     # đăng xuất rồi đăng nhập lại cho có hiệu lực
  docker compose version              # phải in ra v2.x
  ```

- **Máy build cần Internet.** Lúc `docker compose build`, image tải hai thư viện từ CDN và
  đóng gói sẵn vào `/app/vendor/`:
  - `chart.umd.min.js` — Chart.js **4.5.1** (Spendy.html dùng tag `chart.js@4`, đã ghim đúng bản 4.x)
  - `papaparse.min.js` — PapaParse **5.4.1**

  **Lúc chạy thì không cần Internet nữa** — đó chính là lý do phải vendor. Cả hai file được
  kiểm tra SHA-256 ngay trong Dockerfile; tải sai/bị chặn thì build fail chứ không lặng lẽ đi tiếp.

- Biết IP LAN của máy: `hostname -I` hoặc `ip -4 addr show`.
- Ổ đĩa trống: dữ liệu thật khoảng 61 MB (chủ yếu là ảnh hoá đơn); nên chừa tối thiểu 2 GB
  cho database, ảnh và các bản backup.

---

## 2. Lấy mã nguồn

```bash
sudo mkdir -p /srv && sudo chown "$USER" /srv
git clone https://github.com/Zinjpq/Spendy.git /srv/spendy
cd /srv/spendy
```

### 2.1 Tạo thư mục dữ liệu **đúng chủ sở hữu** (bước hay bị quên nhất)

`data/` nằm trong `.gitignore` nên sau khi clone **nó chưa tồn tại**. Nếu cứ thế `up -d`,
Docker sẽ tự tạo `data/` thuộc **root**, mà container chạy bằng user `spendy` (UID 10001)
→ server không ghi được database (`unable to open database file`).

Bind mount **giữ nguyên quyền sở hữu của host**, `chown` trong Dockerfile không cứu được.
Phải chown thủ công một lần:

```bash
mkdir -p data
sudo chown -R 10001:10001 data
```

> Muốn container chạy bằng chính user của bạn thay vì 10001? File `.env` **không** chạy lệnh
> shell, phải ghi số cụ thể vào — dùng luôn hai dòng này:
> ```bash
> echo "SPENDY_UID=$(id -u)" >> .env
> echo "SPENDY_GID=$(id -g)" >> .env
> ```
> Khi đó `data/` cứ để nguyên chủ sở hữu là bạn, không cần `chown`.

### 2.2 Tạo file `.env` (quyết định ai truy cập được)

Mặc định app chỉ nghe ở `127.0.0.1` — an toàn nhưng **máy khác trong nhà sẽ không vào được**.
Tạo file `/srv/spendy/.env`:

```dotenv
# Chọn ĐÚNG MỘT dòng:
SPENDY_BIND=192.168.1.50     # IP LAN của chính máy này  (khuyến nghị)
# SPENDY_BIND=100.101.102.103 # IP Tailscale của máy này (dùng từ xa)
# SPENDY_BIND=0.0.0.0         # mọi giao diện mạng — CHỈ khi có firewall chặn chắc chắn

TZ=Asia/Ho_Chi_Minh
```

`.env` đã được `.gitignore` bỏ qua.

---

## 3. Chuyển dữ liệu cũ sang server

Bản cũ lưu dữ liệu trong file **`spendy-db.js`** (khoảng 61 MB, gồm cả ảnh base64) đặt cạnh
`Spendy.html` trong thư mục Google Drive. Script `server/migrate.py` đọc file đó và nạp thẳng
vào SQLite.

**Bước 1 — chép file sang máy chủ** (chép vào thư mục home trước; `./data` lúc này đã thuộc
UID 10001 nên `scp` thẳng vào đó sẽ bị `Permission denied`):

```bash
# chạy trên máy Windows đang có file (Git Bash / PowerShell):
scp "G:/My Drive/Spendy/spendy-db.js" user@192.168.1.50:~/
```

**Bước 2 — đưa vào `./data` và cho user trong container đọc được** (vì `./data` chính là `/data`
bên trong container):

```bash
cd /srv/spendy
sudo mv ~/spendy-db.js data/
sudo chown 10001:10001 data/spendy-db.js
```

**Bước 3 — build image rồi chạy migration** (chạy một container tạm, xong tự xoá):

```bash
docker compose build

# 3a. Chạy thử trước — không ghi gì cả, chỉ báo sẽ nhập bao nhiêu:
docker compose run --rm spendy python /app/server/migrate.py --dry-run /data/spendy-db.js

# 3b. Nhập thật:
docker compose run --rm spendy python /app/server/migrate.py /data/spendy-db.js
```

- `docker compose run` dùng đúng volume `./data:/data`, nên đường dẫn trong container là
  `/data/spendy-db.js`. Thư mục đích lấy từ `$SPENDY_DATA` (= `/data`), khỏi cần `--data`.
- Migration **khử trùng lặp theo `fingerprint`** (`name|amount|category|dateStr`) nên chạy lại
  lần nữa cũng không nhân đôi dữ liệu — dòng trùng bị bỏ qua chứ không báo lỗi.
- **Nếu database đã có sẵn giao dịch, script sẽ DỪNG** với thông báo "database already holds N
  record(s)". Đó là chốt an toàn cố ý. Muốn gộp thêm thì chạy lại kèm `--force`:
  ```bash
  docker compose run --rm spendy python /app/server/migrate.py --force /data/spendy-db.js
  ```
  `--force` vẫn **chỉ gộp thêm**, không bao giờ xoá dữ liệu đang có.
- Nhập cả file backup JSON cũ cũng được: `... migrate.py /data/spendy-backup-2026-07-28.json`.
- Xem toàn bộ tham số: `docker compose run --rm spendy python /app/server/migrate.py --help`.

**Bước 4 — dọn file nguồn** (nó đã nằm trong database, giữ lại chỉ tốn 61 MB trong mọi bản backup):

```bash
sudo mv data/spendy-db.js ~/spendy-db.js.bak   # giữ tạm ở ngoài cho yên tâm
```

> **Cách khác nếu không dùng được `migrate.py`:** mở bản Spendy cũ, bấm **Settings → Backup
> (JSON)**, rồi ở bản mới dùng **Settings → Restore** và chọn file JSON đó. Server có sẵn
> `POST /api/restore/stage` + `/api/restore/commit`, gộp thêm theo fingerprint, không xoá dữ liệu
> đang có. Lưu ý bản JSON cũ **có** ảnh base64 nên file rất to nhưng vẫn nhập được.

---

## 4. Khởi động

```bash
cd /srv/spendy
docker compose up -d
docker compose ps          # cột STATUS phải là "Up ... (healthy)" sau ~15 giây
```

Kiểm tra nhanh từ chính máy chủ:

```bash
curl -fsS http://127.0.0.1:8765/api/health
# {"ok":true,"records":1234,"images":56,"dbBytes":...,"version":"..."}
```

---

## 5. Mở ứng dụng

Từ điện thoại/laptop trong cùng mạng:

```
http://192.168.1.50:8765
```

(thay bằng IP đã đặt ở `SPENDY_BIND`). Nếu đang để mặc định `127.0.0.1`, chỉ mở được **ngay trên
máy chủ** — muốn máy khác vào thì sửa `.env` rồi `docker compose up -d` để tạo lại container.

Có thể "cài" như app: mở bằng Chrome/Edge trên điện thoại → menu → *Add to Home screen*.

---

## 6. Sao lưu

Có hai kiểu, **nên làm cả hai**:

### 6.1 Backup qua API (gọn, đem đi máy khác được)

```bash
cd ~
curl -fsSL -o "spendy-backup-$(date +%F).zip"  http://127.0.0.1:8765/api/backup.zip   # kèm ảnh
curl -fsSL -o "spendy-backup-$(date +%F).json" http://127.0.0.1:8765/api/backup.json  # không ảnh
```

File `.zip` gồm `spendy-backup.json` + thư mục `images/`; khôi phục bằng nút **Restore** trong app.

### 6.2 Backup nguội cả thư mục `./data`

```bash
cd /srv/spendy
docker compose stop                                   # để WAL được gộp, tránh copy nửa vời
sudo tar czf ~/spendy-data-$(date +%F).tar.gz data
docker compose start
```

Không muốn dừng dịch vụ thì dùng bản sao nóng của SQLite (an toàn khi đang chạy):

```bash
docker compose exec spendy python -c "import sqlite3;s=sqlite3.connect('/data/spendy.db');d=sqlite3.connect('/data/hot-backup.db');s.backup(d);d.close();s.close();print('ok')"
sudo mv /srv/spendy/data/hot-backup.db ~/spendy-$(date +%F).db
```

### 6.3 Cảnh báo về nội dung backup

**CẢ HAI kiểu backup đều chứa số thẻ tín dụng và CVV ở dạng chữ rõ** (bảng `meta`, khoá `cards`).
Hãy coi chúng như mật khẩu:

```bash
gpg -c ~/spendy-backup-2026-07-28.zip     # tạo .gpg, rồi xoá bản chưa mã hoá
shred -u ~/spendy-backup-2026-07-28.zip
```

Đừng đẩy lên Google Drive/Dropbox khi chưa mã hoá, đừng commit vào git (`.gitignore` đã chặn sẵn
`*.db`, `data/`, `spendy-backup*`, nhưng đừng thử vận may).

### 6.4 Tự động hàng ngày (tuỳ chọn)

```bash
crontab -e
# 2 giờ sáng mỗi ngày, giữ 14 bản gần nhất
0 2 * * * curl -fsSL -o /home/user/backups/spendy-$(date +\%F).zip http://127.0.0.1:8765/api/backup.zip && find /home/user/backups -name 'spendy-*.zip' -mtime +14 -delete
```

---

## 7. Cập nhật phiên bản

```bash
cd /srv/spendy
curl -fsSL -o ~/spendy-before-update.zip http://127.0.0.1:8765/api/backup.zip   # backup trước đã
git pull
docker compose build        # cần Internet: tải lại Chart.js + PapaParse
docker compose up -d        # tạo lại container với image mới
docker image prune -f       # dọn image cũ
```

Dữ liệu nằm ở `./data` nên **không bị ảnh hưởng** khi build lại image. Nếu sau khi cập nhật
trình duyệt vẫn hiện bản cũ: `Spendy.html` và `spendy.js` được trả về kèm `Cache-Control:
no-cache`, tải lại trang (Ctrl+F5) là xong.

---

## 8. Xem log

```bash
cd /srv/spendy
docker compose logs -f spendy          # theo dõi trực tiếp
docker compose logs --tail=200 spendy  # 200 dòng cuối
docker inspect --format '{{.State.Health.Status}}' spendy   # healthy / unhealthy / starting
docker stats spendy                    # RAM/CPU khi import file lớn
```

Log đã giới hạn sẵn (`json-file`, tối đa 10 MB × 3 file) nên không thể ăn hết ổ đĩa.

---

## 9. Bảo mật — bắt buộc đọc

1. **Không có xác thực.** Không có user, không có mật khẩu, không có giới hạn tốc độ. Bất kỳ ai
   vào được `http://<ip>:8765` đều có thể xem toàn bộ chi tiêu, xem ảnh hoá đơn, **đọc số thẻ và
   CVV**, và gọi được cả `DELETE /api/records` để xoá sạch.
2. **Không bao giờ mở ra Internet.** Không port-forward trên router, không trỏ tên miền vào,
   không đặt sau reverse proxy công khai. Mặc định `SPENDY_BIND=127.0.0.1` là cố tình để một lần
   `docker compose up` lỡ tay không làm lộ dữ liệu.
3. **Chỉ LAN**, và nên siết thêm bằng firewall:

   ```bash
   sudo apt install -y ufw
   sudo ufw allow from 192.168.1.0/24 to any port 8765 proto tcp
   sudo ufw enable
   ```

4. **Truy cập từ xa: dùng VPN, không dùng port-forward.**

   ```bash
   curl -fsSL https://tailscale.com/install.sh | sh
   sudo tailscale up
   tailscale ip -4            # ví dụ 100.101.102.103
   ```

   Đặt `SPENDY_BIND=100.101.102.103` trong `.env` rồi `docker compose up -d`. Khi đó app chỉ
   nghe trên giao diện Tailscale — chỉ thiết bị trong tailnet của bạn mới vào được, ở đâu cũng
   dùng được. WireGuard tự dựng cũng cho kết quả tương đương.
5. **Thư mục `data/` là dữ liệu tài chính thật.** Không commit, không sync lên cloud khi chưa
   mã hoá, và nhớ nó cũng nằm trong mọi bản snapshot/ảnh đĩa của máy chủ.
6. Container đã chạy **non-root** (UID 10001) và bật `no-new-privileges`. Nếu không thực sự cần
   lưu CVV, cách an toàn nhất vẫn là **đừng nhập CVV** vào Settings → My cards.

---

## 10. Khắc phục sự cố

**`unable to open database file` / `Permission denied` trên `/data`**
`./data` đang thuộc root (Docker tự tạo khi bind mount thiếu thư mục). Sửa:
```bash
cd /srv/spendy && docker compose down
sudo chown -R 10001:10001 data && docker compose up -d
```

**Máy khác trong LAN không mở được, nhưng `curl` trên máy chủ thì được**
Vẫn đang bind loopback. Kiểm tra:
```bash
grep SPENDY_BIND .env
docker compose ps            # cột PORTS phải là 192.168.1.50:8765->8765/tcp
ss -ltnp | grep 8765
```
Sửa `.env` xong phải chạy lại `docker compose up -d` (đổi `ports` bắt buộc tạo lại container).
Nếu vẫn không được thì kiểm tra `ufw status`.

**Build fail: `VENDOR CHECKSUM MISMATCH`**
File tải về không khớp SHA-256 đã ghim: mạng có proxy/captive portal chèn nội dung, hoặc CDN đổi
file. Kiểm tra bằng tay rồi mới cập nhật hash trong `Dockerfile`:
```bash
curl -fsSL https://cdn.jsdelivr.net/npm/chart.js@4.5.1/dist/chart.umd.min.js | sha256sum
# phải ra 48444a82d4edcb5bec0f1965faacdde18d9c17db3063d042abada2f705c9f54a
```

**Build fail: `Could not resolve host` / timeout**
Máy build không có Internet. Bắt buộc phải có mạng lúc build (chỉ lúc build). Nếu máy chủ hoàn
toàn offline: build ở máy có mạng rồi `docker save spendy:local | gzip > spendy.tgz`, chép sang
và `docker load < spendy.tgz`.

**`port is already allocated`**
Cổng 8765 đang bận (bản `serve_spendy.py` cũ chẳng hạn). Đổi cổng phía host trong
`docker-compose.yml`: `- "${SPENDY_BIND:-127.0.0.1}:8766:8765"` rồi truy cập cổng 8766.

**Container `unhealthy` hoặc restart liên tục**
```bash
docker compose logs --tail=100 spendy
docker compose run --rm spendy python /app/server/app.py   # chạy nổi để thấy traceback
```
Thường gặp: `./data` không ghi được, hoặc file `server/` thiếu.

**`docker stop` mất tận 10 giây**
`init: true` bị xoá khỏi `docker-compose.yml`. Python chạy ở PID 1 mặc định bỏ qua SIGTERM;
`init: true` cho docker-init (tini) làm PID 1 và chuyển tiếp tín hiệu.

**Tiếng Việt hiển thị sai (đ, ế, ộ thành ký tự lạ)**
Server luôn trả JSON UTF-8 và SQLite lưu UTF-8. Lỗi hầu như luôn nằm ở file nguồn lúc import
(CSV xuất từ Excel hay bị CP1258/CP1252). Kiểm tra nhanh:
```bash
curl -fsS http://127.0.0.1:8765/api/state | head -c 300
```

**Import/restore file lớn (~61 MB) bị đứt giữa chừng**
Kiểm tra dung lượng trống (`df -h`) và log. Nên nhập từ máy nối dây/Wi-Fi ổn định; đừng đóng tab
khi đang chạy. Restore đi qua hai bước (stage → commit), stage lỗi thì database vẫn nguyên vẹn;
file tạm nằm ở `data/tmp/` và tự dọn sau 1 giờ.

**Ảnh hoá đơn không hiện (404 ở `/api/images/<hash>`)**
Record còn hash nhưng file ảnh không có trong `data/images/`. Thường do khôi phục bằng
`backup.json` (bản không kèm ảnh) thay vì `backup.zip`. Khôi phục lại từ file `.zip`.

**Hết dung lượng / muốn dọn ảnh mồ côi**
```bash
curl -fsS -X POST http://127.0.0.1:8765/api/maintenance/gc-images
du -sh /srv/spendy/data/*
```

**DevTools báo 404 `chart.umd.min.js.map`**
Bình thường: chỉ vendor file JS, không vendor source map. Không ảnh hưởng gì.

**Font chữ trông khác khi máy không có Internet**
Ba font (Manrope / Newsreader / JetBrains Mono) vẫn tải từ Google Fonts, **không** được đóng gói
vào image. Mất mạng thì trình duyệt lùi về font hệ thống — giao diện hơi khác nhưng mọi chức năng
vẫn chạy bình thường. Muốn hoàn toàn offline thì phải tải font về `vendor/` và sửa `Spendy.html`
(nằm ngoài phạm vi phần triển khai này).

**Kiểm tra xem app có đang dùng bản vendor hay lén ra CDN**
`Spendy.html` có cơ chế dự phòng: nếu `vendor/chart.umd.min.js` không tải được, nó tự chèn thẻ
`<script>` trỏ ra CDN. Nghĩa là biểu đồ vẫn chạy *khi có mạng* dù file vendor hỏng. Muốn chắc chắn
bản LAN thật sự offline-ready:
```bash
curl -fsS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8765/vendor/chart.umd.min.js   # 200
curl -fsS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8765/vendor/papaparse.min.js   # 200
```

**Ngày giao dịch lệch 1 ngày**
Không phải lỗi server — server lưu `dateStr`/`monthKey` **nguyên văn** như client gửi và không
bao giờ tự suy ngày từ timestamp. Kiểm tra múi giờ của máy đang mở trình duyệt.

**Làm lại từ đầu (XOÁ SẠCH DỮ LIỆU)**
```bash
cd /srv/spendy
curl -fsSL -o ~/spendy-last.zip http://127.0.0.1:8765/api/backup.zip   # backup trước!
docker compose down
sudo rm -rf data/spendy.db data/spendy.db-wal data/spendy.db-shm data/images data/tmp
sudo chown -R 10001:10001 data
docker compose up -d
```

---

## 11. Bảng lệnh nhanh

| Việc | Lệnh |
|---|---|
| Khởi động | `docker compose up -d` |
| Dừng | `docker compose stop` |
| Dừng và xoá container | `docker compose down` (dữ liệu ở `./data` vẫn còn) |
| Khởi động lại | `docker compose restart` |
| Log | `docker compose logs -f spendy` |
| Kiểm tra sống | `curl -fsS http://127.0.0.1:8765/api/health` |
| Backup | `curl -fsSL -o bk.zip http://127.0.0.1:8765/api/backup.zip` |
| Cập nhật | `git pull && docker compose build && docker compose up -d` |
| Nạp dữ liệu cũ | `docker compose run --rm spendy python /app/server/migrate.py /data/spendy-db.js` |
| Shell trong container | `docker compose exec spendy python` |
