-- 008 · Registro de cada alerta enviada (o fallida) por WhatsApp.
-- Antes un fallo quedaba solo en el log de Render y el alertador anotaba "alerta mandada" aunque no saliera nada.
create table if not exists public.whatsapp_envios (
  id          bigserial primary key,
  creado_en   timestamptz not null default now(),
  telefono    text not null,
  tipo        text not null default 'alerta_diaria',
  estado      text not null check (estado in ('enviado','error','sin_plantilla')),
  detalle     text,
  wa_mensaje  text
);
create index if not exists whatsapp_envios_creado_idx on public.whatsapp_envios (creado_en desc);
alter table public.whatsapp_envios enable row level security;
revoke all on public.whatsapp_envios from public, anon, authenticated;

-- Solo el bot (llave secreta de Supabase) puede escribir.
create or replace function public.bot_registrar_envio_whatsapp(p_telefono text, p_tipo text, p_estado text, p_detalle text, p_wa_mensaje text)
returns void language sql security definer set search_path to 'public' as $$
  insert into public.whatsapp_envios (telefono, tipo, estado, detalle, wa_mensaje)
  values (right(regexp_replace(coalesce(p_telefono,''), '\D', '', 'g'), 15), coalesce(nullif(p_tipo,''),'alerta_diaria'), p_estado, left(p_detalle, 500), p_wa_mensaje);
$$;
revoke all on function public.bot_registrar_envio_whatsapp(text,text,text,text,text) from public, anon, authenticated;
grant execute on function public.bot_registrar_envio_whatsapp(text,text,text,text,text) to service_role;

-- Lectura para el superadmin del panel (últimos 200).
create or replace function public.panel_listar_envios_whatsapp(p_token text)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
begin
  if not public._es_superadmin(p_token) then
    return jsonb_build_object('ok', false, 'motivo', 'no autorizado'); end if;
  return jsonb_build_object('ok', true, 'envios', coalesce((
    select jsonb_agg(to_jsonb(e) order by e.creado_en desc)
    from (select creado_en, telefono, tipo, estado, detalle from public.whatsapp_envios order by creado_en desc limit 200) e), '[]'::jsonb));
end $$;
grant execute on function public.panel_listar_envios_whatsapp(text) to anon, authenticated;
