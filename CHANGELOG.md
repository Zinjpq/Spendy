# Changelog

Các thay đổi đến từ **MarkUp change request** — ảnh chụp màn hình có chú thích kèm ghi chú
tiếng Việt. Mỗi mục ghi lại *yêu cầu gốc*, *đã làm gì*, và *chỗ nào trong code* để sau này còn
truy được vì sao một quyết định UI trông như vậy.

---

## 2026-07-20 — Settings gọn lại, Overview layout nhìn được, xác nhận danh mục

Nguồn: `MarkUp.docx` (annotation trên trang Settings, `2026-07-20 13:02`). Ba yêu cầu, đã làm xong cả ba.

Bối cảnh lúc chú thích: Settings là **một cột dài** — Data · My cards · Categories · Budgets ·
50/30/20 · Possibly miscategorized · Overview layout · Danger zone xếp dọc, nửa phải màn hình
trống trơn, phải cuộn rất nhiều mới hết trang.

### ① Xác nhận "đúng chỗ rồi" cho gợi ý sai danh mục

> *"thêm confirm rằng cái này đặt đúng chỗ"* — trỏ vào panel **Possibly miscategorized**
> (lúc đó đang gợi ý `cọc Wifi`: Shopping → Bills & Utilities)

Panel chỉ có một hướng: đồng ý đổi danh mục. Không có cách nói "gợi ý sai, danh mục hiện tại
mới đúng", nên cùng một dòng bị nhắc lại mãi.

**Đã làm** — thêm nút `✓ Đúng chỗ rồi` trên mỗi dòng gợi ý:

- Nút `.mis-ok` → `window.catOkay(id)`, giữ nguyên danh mục và **thôi gợi ý** cho nó —
  không đổi một byte dữ liệu giao dịch nào ([spendy.js:2197](spendy.js#L2197), [:2207](spendy.js#L2207))
- Khoá lưu là **`${norm(name)}|${category}`**, không phải `id` hay `fingerprint` — nên xác nhận
  một lần là im luôn cho mọi giao dịch cùng tên về sau; chuyển sang danh mục khác thì được
  gợi ý lại ([spendy.js:2212](spendy.js#L2212))
- Lưu ở meta key `catOk` ([spendy.js:132](spendy.js#L132), nạp tại [:539](spendy.js#L539)), có trong Backup/Restore
  ([spendy.js:2702](spendy.js#L2702), [:2770](spendy.js#L2770))
- Chân panel đếm số đã xác nhận + nút hoàn tác: *"✓ N transaction(s) confirmed as correctly
  placed · show them again"* → `window.misReset()` ([spendy.js:2171](spendy.js#L2171), [:2221](spendy.js#L2221))
- `applyCategoryRenames` **ánh xạ `catOk` theo tên danh mục mới** để đổi tên / gộp danh mục
  không làm các gợi ý đã tắt sống lại ([spendy.js:2602](spendy.js#L2602))

### ② Overview layout: bản thu nhỏ của lưới thật, thay danh sách phẳng

> *"không hình dung được xếp layout như nào"* — trỏ vào panel **Overview layout**

Lúc đó panel là một danh sách dọc đánh số `Pinned card 1 · Saving Plans 2 · 50/30/20 3 · Stat
cards 4 · Cashflow 5 · Recent 6 · Statistic 7 · Activity 8 · Budgets 9`. Con số cho biết thứ tự
nhưng **không cho biết panel nằm cột nào** — mà Overview có 3 cột, nên nhìn danh sách không
dựng lại được trang trong đầu.

**Đã làm** — vẽ đúng hình dạng lưới Overview thật:

- `renderOvLayoutSettings` dựng **3 cột đúng tỉ lệ `1fr 1.5fr 1fr`** kèm tiêu đề
  LEFT / MIDDLE / RIGHT ([spendy.js:3569](spendy.js#L3569), [:3583](spendy.js#L3583))
- Mỗi panel là một chip `.ovl-chip` (⠿ + emoji + tên + nút 👁): **kéo trong cột để đổi thứ tự,
  kéo sang cột khác để đổi cột**; vị trí chèn tính theo con trỏ ([spendy.js:3625-3659](spendy.js#L3625-L3659))
- Nút 👁 bật/tắt hiển thị **mà giữ nguyên vị trí** — ẩn rồi hiện lại không mất chỗ
- Mỗi cột là một drop zone `.ovl-drop` có viền nét đứt, sáng lên khi kéo vào
  ([Spendy.html:431-434](Spendy.html#L431-L434))
- Lưu meta `overviewWidgets` = `[{id, visible, col}]`; chân thẻ có "N shown · M hidden" +
  **Reset to default layout**

### ③ Settings hai cột bằng nhau, gộp các thẻ chung chức năng

> *"chuyển bớt sang bên này thành 2 cột bằng nhau cho setting đỡ dài và những cái chung chức
> năng thì giữ lại 1 cái"* — mũi tên từ vùng trống bên phải trang

**Đã làm** — hai việc tách biệt: chia cột, và giảm số thẻ.

Chia cột:

- `.settings-grid` = **`1fr 1fr`**, mỗi cột là một `.set-col` ([Spendy.html:371](Spendy.html#L371))
- `#settings-view{max-width:1180px}` để dòng không dài quá ([Spendy.html:368](Spendy.html#L368))
- Dưới 980px tự về **một cột** ([Spendy.html:383](Spendy.html#L383))
- Cột trái: Data · My cards · Overview layout — cột phải: Categories & 50/30/20 · Budgets ·
  Possibly miscategorized

Gộp thẻ (dùng sub-section `.set-sub` có viền trên + tiêu đề `.set-sub-h`, thay vì mỗi thứ một
thẻ `.panel` riêng — [Spendy.html:378-379](Spendy.html#L378-L379)):

- **Thẻ "Data"** gom *mọi* đường dữ liệu ra/vào: 4 nút Import / Export / Backup / Restore xếp
  **lưới 2×2** (`.settings-acts.grid2`, [Spendy.html:376](Spendy.html#L376)) + sub-section **Server**
  (trạng thái kết nối + backup .json, [Spendy.html:945](Spendy.html#L945)) + **Danger zone**
  (Delete all data, [Spendy.html:956](Spendy.html#L956)). Trước đó là 3 thẻ rời.
- **Thẻ "Categories & 50/30/20"** gộp hai thẻ cũ thành một: hai nút trên header + hai dòng
  tóm tắt `#cats-summary` và `#set-class-status` ([Spendy.html:985-986](Spendy.html#L985-L986))
- Danh sách danh mục (rất dài) dời vào **modal** `#cats-overlay` mở bằng "Manage categories",
  nên thẻ Settings chỉ còn header + nút + một dòng tóm tắt

⚠️ Mọi **id** cũ (`import-btn`, `server-status`, `set-budgets`, `set-misclass`, `cats-summary`,
`set-class-status`…) **giữ nguyên** khi sắp xếp lại — JS tìm phần tử theo id.

---

## 2026-07-30 — Dùng được trên điện thoại

Nguồn: ảnh chụp màn hình app mở qua Tailscale trên điện thoại (`100.111.6.24:8765`) + *"xem thử"*.
Ba lỗi, đã sửa cả ba.

### ① Số tiền bị xé giữa dòng

Thẻ thống kê Overview hiện `4.308.8 / 31đ`, `-5.934.87 / 9đ` — `.card .value` có
`word-break:break-word`, mà tiền không có dấu cách nên mọi chỗ ngắt đều rơi vào giữa số.

**Đã làm** — `word-break:normal;overflow-wrap:normal;white-space:nowrap` ([Spendy.html:178](Spendy.html#L178));
để không tràn thay vì xuống dòng, mỗi thẻ tự thành **container** và cỡ chữ co theo bề rộng của
chính nó: `font-size:clamp(12.5px,15cqi,18px)` ([Spendy.html:573](Spendy.html#L573)).

### ② `@media(max-width:768px)` thiếu dấu `}`

Media query mobile mở ra mà không đóng, nên **toàn bộ CSS phía sau nó tới hết stylesheet**
(`.debt-row*`, `.debt-badge*`, `.debts-grid`, cả `@media(max-width:1024px)` lồng bên trong) chỉ
áp dụng khi màn hình ≤768px. Chưa gây hại vì đó là CSS của UI nợ thủ công đã dormant — nhưng bất
kỳ rule thêm vào cuối `<style>` sẽ âm thầm thành mobile-only.

**Đã làm** — đóng block, kèm cảnh báo ngay tại chỗ ([Spendy.html:658](Spendy.html#L658)).
⚠️ Cảnh báo đó **không được** viết thẻ đóng `style` dạng literal trong CSS comment: HTML parser
kết thúc phần tử ngay tại đó, bất kể cú pháp comment của CSS.

### ③ Sidebar trên điện thoại → bottom tab bar

Trước đây mobile chỉ `flex-wrap` cái sidebar thành hàng ngang: nav biến thành một đống chip
2-cái-mỗi-dòng, brand + Add + Dark mode + pill server chiếm gần nửa chiều cao trước khi tới nội dung.

**Đã làm** ([Spendy.html:658](Spendy.html#L658) — toàn bộ trong block ≤768px, không đổi một dòng JS nào):

- `.sidebar` → **thanh tab cố định dưới đáy**, 6 tab icon-trên-nhãn-dưới, `env(safe-area-inset-bottom)`
- `#add-btn` → **FAB tròn** phía trên thanh tab; `#theme-btn` + `.conn-pill` thành 2 chip nổi ở đỉnh
- `main` chừa padding trên/dưới cho hai thanh; `.toast` nâng lên khỏi FAB
- Bảng ledger: ẩn cột `#`, đặt `min-width:430px` để tên thôi bị nén thành "Luong / thang / 07"
- **Cột "Paid" của tab Credit Cards ghim vào lề phải** (`position:sticky;right:0`) — nó là hành động
  chính của tab, không được là cột trôi ra ngoài. Nhận diện bảng đó bằng `:has(th:nth-child(8))`,
  bảng duy nhất `renderTable` sinh 8 cột
- `.scroll-box` (bọc Recent Transactions / Recent Activity / danh sách budget) **chưa từng có CSS** →
  thêm `overflow-x:auto`, trước đó bảng rộng hơn panel thì tràn ra ngoài chứ không cuộn
- Recent Transactions co theo **container chứ không theo viewport** ([Spendy.html:592](Spendy.html#L592)) —
  panel kéo được sang cột khác nên bề rộng cửa sổ không nói gì về chỗ nó thực có; ≤470px bỏ cột
  Status (thứ Date đã nói rồi), ≤355px thu nhỏ tiếp

Kiểm chứng: chụp headless Edge ở 390px (Overview / Expenses / Income / Credit Cards / Settings /
modal Add) và 1000 · 1200 · 1440px để chắc desktop không hồi quy. ⚠️ `--window-size=390` bị Edge
**kẹp lên 492px** trong khi ảnh vẫn xuất đúng 390 → trông y như tràn ngang; muốn viewport 390 thật
thì nhúng app vào `<iframe width="390">` rồi chụp trang bọc ngoài.

---

## Ghi chú về nguồn

`MarkUp.docx` xuất ra kèm CSS selector cho từng annotation (`div.panel.settings-card:nth-child(7)`,
`div.app:nth-child(1)`, `main`). **Đừng tin các selector đó** — chúng là `nth-child` chung chung,
trỏ vào container bao ngoài chứ không phải phần tử được khoanh. Cái đáng tin là **ảnh chụp**:
vùng khoanh đỏ và vị trí mũi tên mới cho biết yêu cầu nói về panel nào.
