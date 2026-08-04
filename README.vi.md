# Spendy

**Tiếng Việt** · [English](README.md)

Ứng dụng theo dõi chi tiêu cá nhân **không cần build**, self-host bằng Docker trên máy chủ của bạn.
Tiền tệ là **đồng Việt Nam**, dữ liệu nằm trên server của bạn — một file SQLite cộng với ảnh hoá đơn
nằm cạnh nó — không có tài khoản, không có cloud, không có ai khác đọc được.

![Overview](docs/img/overview-dark.png)

Toàn bộ ứng dụng là **ba file mã nguồn**: `Spendy.html` (giao diện + CSS), `spendy.js` (~3.9k dòng
logic client), `server/app.py` (~1.9k dòng backend). Không `package.json`, không bundler, không bước
build, không test runner. Backend chỉ dùng **thư viện chuẩn Python** — đúng 18 lệnh `import`, tất cả
đều là stdlib, không `pip install` gì cả.

> Giao diện (tab, tiêu đề panel, nút bấm) đang là **tiếng Anh**; khá nhiều chữ phụ — toast, phần trợ
> giúp trong Settings, hộp thoại backup/restore — vẫn là tiếng Việt. Đó là lý do ảnh chụp bên dưới lẫn
> hai thứ tiếng.

---

## Xem qua

### Overview — mọi thứ trên một màn hình

Tổng quan gộp cả ba dòng tiền (chi / thu / đầu tư). Thẻ được ghim, saving plans, thanh 50/30/20
(thiết yếu / mong muốn / tiết kiệm), biểu đồ dòng tiền theo tháng, giao dịch gần đây, doughnut theo
danh mục, và tiến độ budget. **Kéo–thả để đổi thứ tự hoặc chuyển panel sang cột khác, bấm 👁 để ẩn**
(Settings → Overview layout) — bố cục là của bạn, không phải của tôi.

Sáng và tối là hai chủ đề thật sự, mọi màu đều đi qua biến CSS (kể cả màu trục biểu đồ):

![Overview – chủ đề sáng](docs/img/overview-light.png)

### Ba sổ ledger — Expenses · Income · Investments

Mỗi loại giao dịch có sổ riêng, cùng một bố cục: bảng bên trái, doughnut + danh sách danh mục bên phải.
**Bấm một lát bánh hoặc một dòng danh mục để lọc bảng** ngay tại chỗ. Tìm kiếm **bỏ dấu** — gõ
`ca phe` vẫn ra `Cà phê`.

![Expenses](docs/img/expenses.png)

### Credit Cards — thứ mà app chi tiêu khác không có

Tab này gom mọi giao dịch trả bằng thẻ tín dụng và trả lời đúng một câu hỏi: **còn nợ bao nhiêu, hạn nào**.

- Panel "Remaining owed" nhóm theo **thẻ × kỳ sao kê**, kèm đếm ngược tới hạn thanh toán (đỏ khi sắp trễ hoặc đã quá hạn).
- Tick ✓ để đánh dấu đã trả — cột **Paid on** ghi lại đúng ngày bạn bấm.
- **Trả góp là MỘT giao dịch + số kỳ**, không phải N dòng rác trong sổ. Chi tiêu vẫn tính trọn vào
  tháng mua; panel tự ảo hoá ra N kỳ để bạn tick từng kỳ.

![Credit Cards](docs/img/credit-cards.png)

### Nhập giao dịch trong vài giây

Chip **mẫu nhanh** điền sẵn hình dạng giao dịch hay lặp lại. Gõ tên xong app **gợi ý danh mục** —
ưu tiên thói quen của chính bạn, không khớp thì mới dùng máy từ khoá (Việt + Anh). Trả bằng thẻ thì
hiện luôn ô chọn *mua trước trả sau* / *trả góp*. Đính kèm được ảnh hoá đơn.

![Add transaction](docs/img/add-transaction.png)

### Settings — dữ liệu và cấu hình ở cùng một chỗ

Import/Export CSV, Backup/Restore, trạng thái server, quản lý thẻ, trình sửa budget kéo–thả,
mẫu nhanh, và bộ dò **"có thể để nhầm danh mục"** (bấm *✓ Đúng chỗ rồi* là nó im luôn với tên đó
trong danh mục đó).

![Settings](docs/img/settings.png)

### Điện thoại

App được mở qua LAN/Tailscale từ điện thoại nên đây là đường dùng thật, không phải trường hợp phụ.
Dưới 768px sidebar thành **bottom tab bar**, nút Add thành **FAB tròn**, cột "Paid" của tab Credit
Cards **dính vào mép phải** để không trôi mất khi cuộn ngang. Tất cả bằng CSS thuần — không một nhánh
JS nào, không markup riêng.

![Điện thoại](docs/img/mobile.png)

*(Mọi số liệu, tên và số thẻ trong các ảnh trên đều là dữ liệu giả.)*

---

## Chạy nhanh

```bash
mkdir -p data && sudo chown -R 10001:10001 data   # container chạy non-root UID 10001
docker compose up -d                              # → http://127.0.0.1:8765
```

⚠️ **Mặc định chỉ loopback.** `docker-compose.yml` publish `${SPENDY_BIND:-127.0.0.1}:8765:8765`, nên
ngay sau `up` thì **chỉ chính máy đó** vào được. Muốn dùng từ điện thoại/máy khác, tạo `.env` cạnh
`docker-compose.yml` rồi `docker compose up -d` lại:

```bash
SPENDY_BIND=192.168.1.50      # IP LAN của máy này  (trong nhà — tốt)
# SPENDY_BIND=100.x.y.z       # IP Tailscale        (từ xa — tốt)
# SPENDY_BIND=0.0.0.0         # mọi interface       (CHỈ khi sau firewall bạn tin)
```

Chạy không cần Docker (để phát triển):

```bash
SPENDY_DATA=./data python server/app.py     # rồi mở http://127.0.0.1:8765
node --check spendy.js                      # kiểm tra cú pháp — không có test runner
```

Chi tiết triển khai Debian 12 (kể cả cách mang dữ liệu cũ sang): [docs/DEPLOY.md](docs/DEPLOY.md).

⚠️ **Phải mở qua `http://` từ server** — mở thẳng `Spendy.html` bằng `file://` sẽ báo mất kết nối,
vì trình duyệt không còn giữ bản sao dữ liệu nào nữa.

## Kiến trúc

**Server-authoritative**: SQLite trên server là nguồn sự thật duy nhất; trình duyệt không lưu **dữ liệu**
nào (localStorage chỉ giữ theme + trạng thái thu gọn sidebar).

```text
[CSV / .zip backup] → PapaParse / makeRecord
    ↓  fetch()
[server/app.py]  ── REST /api/*  (Python stdlib, không dependency)
    ↓
[SQLite: records + meta + images]  +  [images/<2hex>/<sha256>.<ext>]   ← volume Docker, KHÔNG nằm trong repo
    ↓  GET /api/state
[spendy.js state] → render() → DOM + Chart.js
```

| File | Vai trò |
|---|---|
| `Spendy.html` | giao diện + CSS + script chống nháy theme |
| `spendy.js` | toàn bộ logic client (~3.9k dòng) |
| `server/app.py` | HTTP + REST + SQLite + phục vụ file tĩnh (~1.9k dòng, **chỉ thư viện chuẩn**) |
| `server/migrate.py` | nạp `spendy-db.js` / backup JSON cũ vào SQLite (có `--dry-run`) |
| `Dockerfile` | `python:3.12-slim`; vendor Chart.js 4.5.1 + PapaParse 5.4.1 kèm kiểm SHA-256; chạy non-root |
| `docker-compose.yml` | một service; `SPENDY_BIND`, volume `./data:/data`, healthcheck |
| `docs/API.md` | hợp đồng API (⚠️ hiện lệch với `server/app.py` ở CORS + TTL staging + allow-list file tĩnh — **lệch thì mã nguồn là chuẩn**) |
| `docs/DEPLOY.md` | hướng dẫn triển khai Debian 12 + Docker |

Hai thư viện runtime được **tải sẵn vào image lúc build** (kiểm SHA-256) nên container chạy được trong
LAN không internet. Bản clone thường không có `vendor/` nên `Spendy.html` tự fallback sang CDN.
Ba font Google Fonts vẫn lấy từ mạng, nên máy không có internet sẽ rơi về font hệ thống — chỉ ảnh
hưởng thẩm mỹ.

## Dữ liệu KHÔNG nằm trong repo

Toàn bộ dữ liệu cá nhân sống trong `data/` (mount vào `/data` của container) và bị `.gitignore` chặn:
`spendy.db`, `images/`, file backup, `spendy-db.js` cũ. `.dockerignore` deny-all trước rồi mới
allow-list nên image cũng sạch.

⚠️ Nhưng **đừng `git add -A` mù**: `.gitignore` chỉ phủ những gì nó biết. Đọc `git status` trước khi
commit — file lạ bạn để cạnh repo (ảnh chụp màn hình, .docx ghi chú…) không được luật nào phủ đâu.

## Nhập / xuất / sao lưu

- **Import CSV**: export từ Notion hoặc từ chính Spendy → `handleCSV` → `processRow` → `makeRecord`
- **Export CSV**: 6 cột (`Name`, `Amount`, `Type`, `Date`, `Categories`, `Payment Method`) + BOM UTF-8
- **Backup (.zip)**: `GET /api/backup.zip` — một file gói đủ **giao dịch + mọi cài đặt + chi tiết thẻ + ảnh đính kèm**
- **Backup (.json)**: cùng payload nhưng không kèm ảnh, tiện diff bằng text
- **Restore**: nhận cả `.zip` lẫn `.json` cũ. Nhánh `.zip` **hai pha** — server ghi file tạm ra đĩa và
  đếm trước "N mới · M trùng" cho bạn xác nhận, chưa chèn dòng nào; bấm huỷ là không có gì xảy ra
- Nhập lại đúng file vừa export là **an toàn và bất biến** — báo "0 mới · N trùng", không đổi gì
- Ảnh lưu theo hash SHA-256 → hai giao dịch dùng chung một ảnh chỉ tốn một file

## Điều khiển bằng script — hoặc bằng AI

Mọi thứ giao diện làm đều đi qua một API REST + JSON thuần: không auth, không session, không SDK. Nên
`curl` là client hạng nhất — và **AI cũng vậy**. Chỉ cần chỉ Claude Code (hoặc bất kỳ công cụ LLM nào
gọi được HTTP) tới [docs/API.md](docs/API.md) là nó đọc được chi tiêu và ghi được giao dịch y hệt cách
app làm: *"tháng 7 tiêu bao nhiêu cho cà phê"*, *"ghi ly cà phê 45k hôm qua"*, *"kỳ sao kê nào chưa trả"*.

```bash
curl -s localhost:8765/api/health                       # {"ok":true,"records":137,"images":0,…}
curl -s localhost:8765/api/state | jq '.records|length' # mọi record + mọi cài đặt, một lần gọi

curl -s -X POST localhost:8765/api/records \
  -H 'Content-Type: application/json' -d '{
    "name": "Cà phê", "amount": 45000, "type": "expense",
    "category": "Coffee", "method": "Cash",
    "dateStr": "2026-08-04", "monthKey": "2026-08", "monthLabel": "August 2026",
    "date": 1785772800000,
    "fingerprint": "Cà phê|45000|Coffee|2026-08-04"
  }'
# → 201 {"ok":true,"record":{…,"id":1}}
#   gửi lại y hệt request đó → 409 duplicate, KHÔNG sinh dòng thứ hai
```

Hai luật người gọi phải theo:

- **Bạn tự tính `fingerprint`** (`name|amount|category|dateStr`). Server không bao giờ tính lại, thiếu
  là `400 missing_fingerprint`. Nó cũng chính là khoá khử trùng lặp, nên **gọi lại một request lỗi là
  an toàn**: lần lặp trả `409`, không đẻ thêm dòng.
- **Ngày là ngày-lịch địa phương.** Tự gửi `dateStr` / `monthKey` / `monthLabel`; server chép nguyên xi
  và không bao giờ suy ngày từ timestamp. Thiếu `monthKey` thì dòng đó rơi vào tháng tên là `Unknown`.

Đọc chạy song song; mọi lệnh ghi giữ một lock toàn tiến trình, và `POST /api/records/bulk` gói cả lô
vào một transaction.

⚠️ Mặt trái nằm ở mục **Bảo mật** bên dưới: API mở như vậy nghĩa là **bất cứ thứ gì** chạm được tới
cổng đó — không riêng gì AI của bạn — đều làm được đúng những việc trên.

## Thiết kế nổi bật

- **4 loại giao dịch**: `expense` / `income` / `invest` / `debt` — mọi phép tính "chi tiêu" chỉ đếm
  `expense`, nên thu nhập, đầu tư và nợ đều tự động nằm ngoài budget/50-30-20
- **Khử trùng lặp** theo `fingerprint = name|amount|category|dateStr`; server tạo `UNIQUE INDEX` lúc
  khởi động, CSDL cũ đã sẵn bản trùng thì chạy chế độ suy giảm (kiểm tra tường minh mỗi lần chèn) + ghi WARN
- **Ghi lô là một transaction** — không bao giờ có chuyện import xong một nửa
- **Ngày là ngày-lịch địa phương**: server lưu nguyên `dateStr` client tính, **không bao giờ** suy lại
  từ timestamp (múi giờ container không đảm bảo trùng máy bạn — suy lại ngày trên một container chạy
  UTC sẽ lùi mọi giao dịch UTC+7 đi một ngày)
- **Thẻ tín dụng + trả góp**: 1 record + `installments`, panel ảo hoá N kỳ sao kê, tick đã-trả từng kỳ
- **Thông báo**: countdown hạn thẻ, danh mục vượt budget, saving plan chạm đích
- **Định dạng số tiền nằm trong đúng một hàm** (`fmt()`) — nhưng hậu tố `đ` còn được viết thẳng ở vài
  label của form, và cảnh báo "quên số 0?" hardcode ngưỡng 1.000đ, nên đổi tiền tệ là một chỉnh sửa
  nhỏ chứ không phải sửa đúng một dòng

## Điều nên biết trước

- **Dedup nuốt giao dịch lặp thật.** Hai ly cà phê 25.000đ cùng quán cùng ngày = một giao dịch; ly thứ
  hai bị bỏ qua khi import, còn ở form Add thì bị chặn ngay trước khi gửi request (server chặn lần
  nữa bằng 409). Đổi tên hoặc số tiền để phân biệt.
- **Restore chỉ gộp thêm, không lùi được.** Khôi phục backup hôm qua sẽ *không* xoá những dòng bạn
  thêm hôm nay. Muốn quay lui thật thì phải Wipe rồi Restore — và Wipe là không hoàn tác được.
- **Xoá giao dịch không xoá ảnh.** Bytes vẫn nằm trên đĩa; chỉ `POST /api/maintenance/gc-images` mới
  dọn, và chưa có nút nào gọi nó.
- **Một người, một tab.** Hai trình duyệt mở cùng lúc sẽ đè cài đặt dạng cả-mảng của nhau (tick đã trả,
  thứ tự budget, danh sách thẻ) — ghi sau thắng, im lặng. Tải lại trước khi sửa ở máy thứ hai.
- **Không có test suite, không có CI.** `node --check` và `ast.parse` chỉ chứng minh file parse được.
  Lưới an toàn của bạn là bản backup mới, không phải build xanh.
- **Phép sửa ngày chạy một lần lúc mở app giả định múi giờ của bạn không đổi** — import khi máy đang
  ở UTC+7 rồi sau đó mở app ở múi giờ khác thì phép sửa đó có thể dịch những ngày kia đi một ngày.

## Bảo mật

**Không có xác thực.** Ai vào được cổng đó là đọc được mọi giao dịch và ảnh hoá đơn, lộ số thẻ + CVV
đã lưu, tải được backup đầy đủ, và gọi được `DELETE /api/records` để xoá sạch. Không rate limit,
không audit log. Vì vậy compose **bind `127.0.0.1` mặc định**; muốn dùng từ xa hãy đi qua
Tailscale/WireGuard, **đừng** port-forward ra internet.

⚠️ **Mọi bản backup là một bản dump số thẻ dạng thô** — `spendy-backup.zip`, `.json` và tarball của
`./data` đều chứa số thẻ, hạn và CVV chưa mã hoá. Đừng thả vào Drive/Dropbox/email; `gpg -c` trước
rồi `shred` bản gốc (xem [docs/DEPLOY.md](docs/DEPLOY.md)).

Bù lại, những thứ *có* được làm nghiêm: phục vụ file tĩnh theo **allow-list đúng tên file** (để một
`spendy-db.js` hay `spendy-backup-*.json` để lạc bên cạnh không bao giờ bị phục vụ); ảnh SVG trả về
`application/octet-stream` (SVG mở trên chính origin phục vụ `/api/state` sẽ chạy script cạnh số thẻ);
entry trong zip restore bị kiểm `..`/đường dẫn tuyệt đối/symlink và mỗi ảnh phải hash đúng tên nó khai;
CORS thu hẹp chứ không `*`, ghi cross-site bị 403; body có trần; container chạy non-root UID 10001 với
`no-new-privileges`.
