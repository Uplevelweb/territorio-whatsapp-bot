-- 001: pagos pendientes (token de Flow -> a quién pertenece) guardados en BD.
create table if not exists public.bot_pagos_pendientes (
  token      text primary key,
  datos      jsonb not null,
  creado_en  timestamptz not null default now()
);
alter table public.bot_pagos_pendientes enable row level security;  -- sin políticas: solo service_role

create or replace function public.bot_guardar_pago_pendiente(p_token text, p_datos jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  delete from public.bot_pagos_pendientes where creado_en < now() - interval '3 days';
  insert into public.bot_pagos_pendientes(token, datos) values (p_token, p_datos)
  on conflict (token) do update set datos = excluded.datos, creado_en = now();
end $$;

-- Lee y borra en un solo paso: un token se usa una sola vez.
create or replace function public.bot_tomar_pago_pendiente(p_token text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v jsonb;
begin
  delete from public.bot_pagos_pendientes where token = p_token returning datos into v;
  return v;
end $$;

revoke all on function public.bot_guardar_pago_pendiente(text, jsonb) from public, anon, authenticated;
revoke all on function public.bot_tomar_pago_pendiente(text)         from public, anon, authenticated;
grant execute on function public.bot_guardar_pago_pendiente(text, jsonb) to service_role;
grant execute on function public.bot_tomar_pago_pendiente(text)         to service_role;
