# Spendy

Ứng dụng theo dõi chi tiêu **không cần build**, self-host bằng Docker trên máy chủ của bạn.

## Chạy nhanh

```bash
docker compose up -d          # http://<ip-lan>:8765
```

Chi tiết triển khai lên Debian 12 (kể cả cách mang dữ liệu cũ sang): [docs/DEPLOY.md](docs/DEPLOY.md).

Chạy không cần Docker (để phát triển):

```bash
SPENDY_DATA=./data python server/app.py     # rồi mở http://127.0.0.1:8765
node --check spendy.js                      # kiểm tra cú pháp, không có test runner
```

⚠️ **Phải mở qua `http://` từ server** — mở thẳng `Spendy.html` bằng `file://` sẽ báo mất kết nối,
vì trình duyệt không còn giữ bản sao dữ liệu nào nữa.

## Kiến trúc

**Server-authoritative**: SQLite trên server là nguồn sự thật duy nhất; trình duyệt không lưu gì.

```text
[CSV / .zip backup] → PapaParse / makeRecord
    ↓  fetch()
[server/app.py]  ── REST /api/*  (Python stdlib, không dependency)
    ↓
[SQLite: records + meta]   +   [images/<sha256>]   ← volume Docker, KHÔNG nằm trong repo
    ↓  GET /api/state
[spendy.js state] → render() → DOM + Chart.js
```

| File | Vai trò |
|---|---|
| `Spendy.html` | giao diện + CSS + theme chống nháy |
| `spendy.js` | toàn bộ logic client (~3.6k dòng) |
| `server/app.py` | HTTP + REST + SQLite + phục vụ file tĩnh, **chỉ dùng thư viện chuẩn** |
| `server/migrate.py` | nạp `spendy-db.js` / backup JSON cũ vào SQLite |
| `docs/API.md` | hợp đồng API — client và server đều bám theo file này |
| `docs/DEPLOY.md` | hướng dẫn triển khai Debian 12 + Docker |

## Dữ liệu KHÔNG nằm trong repo

Toàn bộ dữ liệu cá nhân sống trong thư mục `data/` (mount vào `/data` của container) và bị
`.gitignore` chặn: `spendy.db`, `images/`, file backup, `spendy-db.js` cũ. Repo chỉ có mã nguồn —
push lên GitHub không lộ giao dịch hay số thẻ. `.dockerignore` chặn tương tự để dữ liệu không
bị nướng vào image.

## Nhập / xuất / sao lưu

- **Import CSV**: export từ Notion hoặc từ chính Spendy → `handleCSV` → `processRow` → `makeRecord`
- **Export CSV**: 6 cột (`Name`, `Amount`, `Type`, `Date`, `Categories`, `Payment Method`) + BOM UTF-8
- **Backup (.zip)**: `GET /api/backup.zip` — một file gói đủ **giao dịch + mọi cài đặt + chi tiết thẻ + ảnh đính kèm**
- **Backup (.json)**: cùng payload nhưng không kèm ảnh, tiện diff bằng text
- **Restore**: nhận cả `.zip` lẫn `.json` cũ (ảnh base64 inline vẫn nạp được); luôn **merge thêm** theo
  `fingerprint`, không bao giờ xoá dữ liệu đang có
- Ảnh lưu thành file riêng theo hash SHA-256 → hai giao dịch dùng chung một ảnh chỉ tốn một file

## Thiết kế nổi bật

- **4 loại giao dịch**: `expense` / `income` / `invest` / `debt`
- **Khử trùng lặp** theo `fingerprint = name|amount|category|dateStr` (UNIQUE trong SQLite)
- **Ngày là ngày-lịch địa phương** — server lưu nguyên `dateStr` client tính, không bao giờ suy lại từ timestamp
- **Thẻ tín dụng + trả góp**: 1 record + `installments`, panel ảo hoá N kỳ sao kê + tick đã-trả từng kỳ
- **Notification**: countdown hạn thẻ, vượt budget, đạt saving plan goal
- **Chủ đề sáng/tối** qua CSS variables; biểu đồ lấy màu từ `cssVar('--…')`
- **Tuỳ chỉnh Dashboard**: `overviewWidgets` lưu thứ tự + hiển thị panel

## Bảo mật

Không có xác thực — app **chỉ dành cho LAN/VPN**. `docker-compose.yml` mặc định bind `127.0.0.1`;
muốn truy cập từ xa hãy dùng Tailscale/WireGuard thay vì mở cổng ra internet. Chi tiết thẻ (số + CVV)
lưu **không mã hoá** trong SQLite và có trong mọi bản backup.
