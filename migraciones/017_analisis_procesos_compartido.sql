-- 017 · Análisis de procesos compartido entre clientes, con vida de 10 días.
-- Pedido de Serling (11-10-2026): si Terri ya analizó una licitación o compra ágil, otro cliente que consulte
-- la misma debe recibir lo ya guardado (más rápido y sin gastar IA), y a los 10 días se descarta.
--
-- Qué se guarda: SOLO la parte objetiva (ficha pública + análisis de las bases). La parte personal
-- («Para ti»: experiencia, rubro, historial) se calcula en cada consulta y NO se guarda aquí.
-- Sin RLS abierta: nadie lee esta tabla desde el navegador; solo el bot, con la llave de servicio.

create table if not exists public.analisis_procesos (
  codigo     text primary key,
  tipo       text,
  ficha      jsonb not null,
  analisis   jsonb not null,
  creado_en  timestamptz not null default now()
);
alter table public.analisis_procesos enable row level security;
revoke all on public.analisis_procesos from anon, authenticated;

-- Lee lo guardado, ignorando lo que ya cumplió 10 días.
create or replace function public.bot_analisis_leer(p_codigo text)
returns jsonb language sql stable security definer set search_path to 'public' as $$
  select jsonb_build_object('ficha', ficha, 'analisis', analisis, 'creado_en', creado_en, 'tipo', tipo)
    from public.analisis_procesos
   where codigo = upper(trim(p_codigo)) and creado_en > now() - interval '10 days';
$$;

-- Guarda (o renueva) el análisis y, de paso, descarta lo vencido.
create or replace function public.bot_analisis_guardar(p_codigo text, p_tipo text, p_ficha jsonb, p_analisis jsonb)
returns void language plpgsql security definer set search_path to 'public' as $$
begin
  delete from public.analisis_procesos where creado_en <= now() - interval '10 days';
  insert into public.analisis_procesos(codigo, tipo, ficha, analisis, creado_en)
  values (upper(trim(p_codigo)), p_tipo, p_ficha, p_analisis, now())
  on conflict (codigo) do update
    set tipo = excluded.tipo, ficha = excluded.ficha, analisis = excluded.analisis, creado_en = now();
end $$;

revoke all on function public.bot_analisis_leer(text) from public, anon, authenticated;
revoke all on function public.bot_analisis_guardar(text, text, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.bot_analisis_leer(text) to service_role;
grant execute on function public.bot_analisis_guardar(text, text, jsonb, jsonb) to service_role;

-- Limpieza diaria (04:15 hora de la base) para que lo vencido no se quede aunque nadie analice nada.
select cron.schedule('limpiar-analisis-procesos', '15 4 * * *',
  $c$delete from public.analisis_procesos where creado_en <= now() - interval '10 days'$c$);
