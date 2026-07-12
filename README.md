```text
███████╗██████╗ ███████╗██████╗ ██████╗ ██╗ ██╗███████╗██████╗ ██████╗
██╔════╝██╔══██╗██╔════╝██╔══██╗██╔═══██╗██║ ██║██╔════╝██╔══██╗██╔═══██╗
█████╗ ██████╔╝█████╗ ██████╔╝██║ ██║██║ █╗ ██║█████╗ ██████╔╝██║ ██║
██╔══╝ ██╔══██╗██╔══╝ ██╔══██╗██║ ██║██║███╗██║██╔══╝ ██╔══██╗██║ ██║
██║ ██║ ██║███████╗██║ ██║╚██████╔╝╚███╔███╔╝███████╗██║ ██║╚██████╔╝
╚═╝ ╚═╝ ╚═╝╚══════╝╚═╝ ╚═╝ ╚═════╝ ╚══╝╚══╝ ╚══════╝╚═╝ ╚═╝ ╚═════╝
```

Ứng dụng theo dõi chi tiêu **không cần build** — mở `Spendy.html` là dùng được ngay.

## Chạy nhanh

- Mở trực tiếp `Spendy.html` trong trình duyệt.
- Không cần `npm`, server hay build step.
- Kiểm tra cú pháp: `node --check spendy.js`

## Kiến trúc

Ứng dụng **client-only**, không backend bắt buộc.

```text
[CSV/JSON] → PapaParse / makeRecord
    ↓
[IndexedDB: expenses + meta]
    ↓
[spendy.js state] → render() → DOM + Chart.js
```

- Giao diện: `Spendy.html`
- Logic: `spendy.js` ≈ 3.5k dòng
- Lưu trữ: IndexedDB (`fingerprint` chống trùng)
- Theme: CSS variables + `localStorage` (`spendy-theme`)
- Tính toán: budgets / 50/30/20 / notification đều từ state trong bộ nhớ

## Repo này bao gồm gì

- `Spendy.html` — giao diện, theme chống nháy, CDN Chart.js + PapaParse + Google Fonts
- `spendy.js` — toàn bộ logic
- `serve_spendy.py` — server tĩnh phục vụ `http://127.0.0.1:8765` nếu cần File System Access API ngoài `file://`
- `CLAUDE.md` — ghi chú kiến trúc, luồng dữ liệu, các tab Overview / Expenses / Income / Investments / Credit Cards / Settings

## Lưu trữ

- Dữ liệu chính: **IndexedDB** (`spendy`, `expenses` store + meta store)
- localStorage: chỉ theme `spendy-theme`
- Các file `backup/`, `spendy-sync.json`, `.codegraph/` bị `.gitignore` bỏ qua

## Nhập / xuất / sao lưu

- Import: CSV từ Notion / Spendy export → `handleCSV` → `processRow` → `makeRecord`
- Export CSV: 6 cột (`Name`, `Amount`, `Type`, `Date`, `Categories`, `Payment Method`) + BOM UTF-8
- Backup / Restore: JSON gồm `records` + `budgets` / `goal` / `catClass` / `incomeBase` / `cats` / `plans` / `ccPaidFps` / `cards` / `pinnedCard`
- Ảnh đính kèm lưu trực tiếp trong record (base64), không đưa vào CSV

## Thiết kế nổi bật

- **4 loại giao dịch**: `expense` / `income` / `invest` / `debt`
- **Khử trùng lặp** theo `fingerprint = name|amount|category|dateStr`
- **Thẻ tín dụng + trả góp**: 1 record + `installments`, panel ảo hoá N kỳ sao kê + tick đã-trả từng kỳ
- **Notification**: countdown hạn thẻ, vượt budget, đạt saving plan goal
- **Chủ đề sáng/tối** qua CSS variables; biểu đồ lấy màu từ `cssVar('--…')`
- **Tuỳ chỉnh Dashboard**: `overviewWidgets` lưu thứ tự + hiển thị panel
