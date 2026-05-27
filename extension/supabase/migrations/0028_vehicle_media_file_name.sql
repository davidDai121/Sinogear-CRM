-- vehicle_media 加 file_name 列，保留客户上传时的原文件名
-- 用途：发到 WhatsApp 时显示原文件名（"2025 Changan CS75 Plus Spec Sheet.pdf"
-- 而不是 "Changan_CS75plus.pdf"），更可读且看着专业
-- 老数据 file_name=NULL，发文件时回退到 brand_model.ext

alter table vehicle_media
  add column if not exists file_name text;
