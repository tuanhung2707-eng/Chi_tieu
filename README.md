# Sổ chi tiêu (Supabase + Cloudflare + GitHub)

Web app theo dõi chi tiêu theo ngày: ngân sách chia đều cho các ngày trong kỳ, tiền dư/lố của một ngày được chia đều cho các ngày sau, xem theo bảng tuần, tự chuyển kỳ mới khi hết kỳ.

```
so-chi-tieu/
├── public/
│   ├── index.html        ← toàn bộ giao diện và logic
│   └── config.js         ← 2 giá trị Supabase (bạn điền)
├── supabase/
│   └── schema.sql        ← tạo bảng, bảo mật, hàm tự chuyển kỳ
├── wrangler.jsonc        ← cấu hình Cloudflare
├── .gitignore
└── README.md
```

Vai trò: **GitHub** giữ mã · **Cloudflare** đưa web lên mạng (tự triển khai mỗi khi bạn đẩy mã lên GitHub) · **Supabase** lưu dữ liệu và đăng nhập · **Claude** giúp bạn sửa/thêm tính năng.

---

## Bước 1. Tạo database trên Supabase

1. Vào supabase.com → **New project** (đặt tên, mật khẩu database, chọn vùng gần Việt Nam như Singapore).
2. Khi project tạo xong, mở **SQL Editor → New query**, dán toàn bộ nội dung file `supabase/schema.sql`, bấm **Run**. Thấy "Success" là xong. (Chạy lại nhiều lần vẫn an toàn.)
3. Tạo tài khoản đăng nhập của bạn: **Authentication → Users → Add user → Create new user**, nhập email + mật khẩu, **bật "Auto Confirm User"**.
4. Khóa đăng ký mới để chỉ mình bạn dùng được: **Authentication → Sign In / Providers** (hoặc mục Settings của Authentication) → tắt **"Allow new users to sign up"**.
5. Lấy 2 giá trị cho web: **Project Settings → API Keys**
   - **Project URL** (dạng `https://abcdxyz.supabase.co`)
   - **Publishable key** (dạng `sb_publishable_...`). Nếu project của bạn còn dùng khóa cũ thì dùng `anon key`.

> ⚠️ Chỉ dùng **Publishable (hoặc anon) key**. **Tuyệt đối không** dán `secret key` / `service_role key` vào web hay gửi cho ai. Publishable key được phép công khai vì dữ liệu đã được khóa bằng RLS trong `schema.sql`: mỗi người chỉ đọc/ghi được dữ liệu của chính mình.

## Bước 2. Điền `public/config.js`

```js
window.APP_CONFIG = {
  SUPABASE_URL: 'https://fggbniifqrcgdkasilcc.supabase.co',
  SUPABASE_KEY: 'sb_publishable_qrCpF3obpFcaRyU2mBoqPA_oJxaPRx3'
};
```

## Bước 3. Đưa mã lên GitHub

Cách dễ nhất (không cần cài gì): trên github.com tạo repo mới (ví dụ `so-chi-tieu`, để Private cũng được) → **Add file → Upload files** → kéo cả thư mục này vào (giữ nguyên cấu trúc thư mục) → **Commit**.

Hoặc dùng dòng lệnh:

```bash
cd so-chi-tieu
git init && git add . && git commit -m "Sổ chi tiêu"
git branch -M main
git remote add origin https://github.com/<tên-bạn>/so-chi-tieu.git
git push -u origin main
```

## Bước 4. Triển khai bằng Cloudflare

**Cách A (khuyên dùng): tạo Worker mới đúng tên.**
1. Cloudflare → **Workers & Pages → Create → Import a repository** (Connect to Git), chọn repo vừa tạo.
2. Đặt **tên project = `so-chi-tieu`**. Tên này **phải trùng** với `name` trong `wrangler.jsonc`, nếu lệch build sẽ lỗi.
3. Build command: **để trống**. Deploy command: `npx wrangler deploy`. Bấm **Save and Deploy**.
4. Xong sẽ có địa chỉ dạng `https://so-chi-tieu.<tài-khoản>.workers.dev`. Worker cũ `empty-art-345d` không dùng nữa, bạn xóa được.

**Cách B: dùng lại Worker `empty-art-345d`.** Mở `wrangler.jsonc`, đổi `"name": "so-chi-tieu"` thành `"name": "empty-art-345d"`, rồi vào Worker đó → **Settings → Builds → Connect** chọn repo. Lưu ý lần triển khai tới sẽ ghi đè nội dung bạn đã tải tay lên Worker này.

Từ đó, mỗi lần bạn **commit lên GitHub**, Cloudflare tự build và cập nhật web sau khoảng một phút.

## Bước 5. Dùng thử

1. Mở địa chỉ `workers.dev` → đăng nhập bằng tài khoản ở bước 1.
2. Lần đầu bấm **Tạo kỳ đầu tiên**: nhập ngân sách, ngày bắt đầu và kết thúc (có thể bắt đầu giữa tháng).
3. Thêm khoản chi ở ô phía trên, hoặc bấm vào một ô ngày để thêm/sửa/xóa từng khoản và đánh dấu đã qua.

Dòng chữ nhỏ cuối trang cho biết phiên bản và hoạt ảnh đang bật hay tắt.

---

## Cách app tính tiền

- Ngân sách kỳ chia đều cho mọi ngày trong kỳ.
- Một ngày được **chốt** khi có ít nhất một khoản chi, hoặc bạn đánh dấu **đã qua** (ngày không tiêu gì thì chỉ cần đánh dấu đã qua).
- Tiền **dư hoặc lố** của ngày đã chốt được **chia đều cho tất cả các ngày sau**. Ngày chưa chốt tự cập nhật mức được tiêu.
- **Tự chuyển kỳ:** mỗi lần mở app, hàm `ensure_current_period` kiểm tra. Nếu hôm nay đã qua ngày kết thúc kỳ mới nhất, nó tạo kỳ kế tiếp (giữ nguyên ngân sách cũ, bạn tự sửa; app hiện thông báo nhắc). "Ngày bắt đầu kỳ hằng tháng" chỉnh trong **Cài đặt**: `1` = theo tháng dương lịch, `15` = kỳ từ 15 đến 14 tháng sau.
- Dữ liệu các kỳ cũ giữ nguyên trong database, chọn ở danh sách kỳ dưới tiêu đề để xem lại. Không cần gom hay xóa tab như bản Google Sheet.

## Cập nhật và nhờ Claude sửa

1. Nói với Claude muốn đổi gì, dán file cần sửa (thường là `public/index.html`).
2. Thay file trong repo bằng bản mới, commit.
3. Chờ Cloudflare triển khai xong rồi tải lại trang (Ctrl+Shift+R).

Nếu sửa cấu trúc bảng trong Supabase, hãy chạy đoạn SQL mới trong SQL Editor trước khi triển khai bản web mới.

## Gặp lỗi?

| Hiện tượng | Cách xử lý |
|---|---|
| Trang báo "Cần cấu hình Supabase" | Chưa điền `public/config.js`, hoặc chưa đẩy lên GitHub / Cloudflare chưa triển khai xong. |
| "Sai email hoặc mật khẩu" | Kiểm tra tài khoản ở Authentication → Users; chắc là đã bật Auto Confirm. Đổi mật khẩu ngay trong trang Users. |
| "Không có quyền ghi dữ liệu" | Chưa chạy `supabase/schema.sql` hoặc chạy bị lỗi giữa chừng. Chạy lại toàn bộ file. |
| Build trên Cloudflare lỗi | Tên Worker trên Cloudflare phải trùng `name` trong `wrangler.jsonc`. |
| Sửa xong mà trang không đổi | Chờ build xong (xem tab Deployments/Builds), rồi bấm Ctrl+Shift+R. Dòng cuối trang ghi số phiên bản để đối chiếu. |
| Không thấy hoạt ảnh | Thiết bị đang bật "giảm chuyển động" (dòng cuối trang sẽ ghi rõ). |

## Bảo mật cần nhớ

- `config.js` chỉ chứa URL và Publishable key (công khai được). Không bao giờ commit `secret`/`service_role` key.
- Đã tắt đăng ký mới và bật RLS; người lạ có mở trang cũng không đăng nhập hay đọc được dữ liệu.
- Repo để Private cho gọn, dù không bắt buộc.
