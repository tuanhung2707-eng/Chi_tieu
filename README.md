Quản lý chi tiêu cá nhân — Cloudflare Pages + GitHub + Supabase
1. Supabase
Mở SQL Editor → New query, dán `supabase/schema.sql`, nhấn Run.
Lấy Project URL và Publishable key trong phần Connect / API.
Trong `index.html`, thay `YOUR\_SUPABASE\_URL` và `YOUR\_SUPABASE\_PUBLISHABLE\_KEY`.
Không dùng service_role/secret key ở trình duyệt. Bảng đã bật RLS theo user_id.
2. GitHub
Tạo repository mới rồi upload `index.html`, `README.md`, `supabase/schema.sql` lên nhánh `main`.
3. Cloudflare Pages
Workers & Pages → Create → Pages → Connect to Git → chọn repository.
Framework preset: None. Build command: `exit 0` (hoặc để trống nếu giao diện cho phép). Build output directory: `.`. Deploy.
Chức năng hiện có
Đăng nhập/tạo tài khoản, ngân sách theo tháng, thêm/xóa khoản chi và bảng chi tiêu. Bản này là nền tảng mới, chưa phải bản chuyển đổi đầy đủ mọi tính năng trong file Apps Script trước đó (ví dụ ngày không tiêu cộng dồn, khoảng ngày tùy chỉnh, sửa khoản chi).
