-- 020 · Borrar a un suscriptor de la lista TAMBIEN cancela su cobro en Flow, sea cual sea la forma
-- en que se borre (25-10-2026, pedido de Serling). Aplicada el 26-10-2026 ("PASAR A PRODUCCION").
--
-- Problema: el boton «Eliminar» del panel ya cancela en Flow antes de borrar (009), pero un DELETE
-- directo en Supabase (tabla / SQL) o bot_borrar_suscriptor por otra via solo borra la fila, y la
-- suscripcion queda activa en Flow cobrando a alguien que ya no esta en la lista.
--
-- Solucion: al borrarse un suscriptor que tenia suscripcion o cliente en Flow, se anota una orden en
-- `flow_cancelaciones_pendientes`. El bot la procesa cada 15 minutos (/tareas/cancelar-flow-huerfanos):
-- cancela la suscripcion en Flow (corte inmediato), borra el cliente (tarjeta registrada) y marca la
-- orden como hecha. Si Flow falla, reintenta (hasta 10 veces) y el error queda anotado en la orden.
-- Si el panel ya la habia cancelado, el bot lo detecta (estado cerrado) y solo marca la orden.

create table if not exists public.flow_cancelaciones_pendientes (
  id bigserial primary key,
  correo text,
  flow_subscription_id text,
  flow_customer_id text,
  creada timestamptz not null default now(),
  hecha_en timestamptz,
  intentos int not null default 0,
  ultimo_error text
);
alter table public.flow_cancelaciones_pendientes enable row level security;  -- sin politicas: solo service_role
revoke all on table public.flow_cancelaciones_pendientes from public, anon, authenticated;

create or replace function public.bot_encolar_cancelacion_flow() returns trigger
language plpgsql security definer set search_path to 'public' as $$
begin
  if nullif(old.flow_subscription_id, '') is not null or nullif(old.flow_customer_id, '') is not null then
    insert into public.flow_cancelaciones_pendientes(correo, flow_subscription_id, flow_customer_id)
    values (old.email, nullif(old.flow_subscription_id, ''), nullif(old.flow_customer_id, ''));
  end if;
  return old;
end $$;

drop trigger if exists encolar_cancelacion_flow on public.suscriptores;
create trigger encolar_cancelacion_flow
  after delete on public.suscriptores
  for each row execute function public.bot_encolar_cancelacion_flow();

create or replace function public.bot_flow_cancelaciones_pendientes()
returns setof public.flow_cancelaciones_pendientes
language sql security definer set search_path to 'public' as $$
  select * from public.flow_cancelaciones_pendientes
   where hecha_en is null and intentos < 10 order by id limit 50
$$;

create or replace function public.bot_flow_cancelacion_marcar(p_id bigint, p_ok boolean, p_error text default null)
returns void language sql security definer set search_path to 'public' as $$
  update public.flow_cancelaciones_pendientes
     set intentos = intentos + 1,
         hecha_en = case when p_ok then now() else null end,
         ultimo_error = p_error
   where id = p_id
$$;

revoke all on function public.bot_flow_cancelaciones_pendientes() from public, anon, authenticated;
revoke all on function public.bot_flow_cancelacion_marcar(bigint, boolean, text) from public, anon, authenticated;
grant execute on function public.bot_flow_cancelaciones_pendientes() to service_role;
grant execute on function public.bot_flow_cancelacion_marcar(bigint, boolean, text) to service_role;

-- El reloj: cada 15 minutos, con la misma clave (por cabecera) que ya usa «sincronizar-al-dia».
do $$
declare v_cmd text; v_clave text;
begin
  if to_regnamespace('cron') is null then return; end if;
  select command into v_cmd from cron.job where jobname = 'sincronizar-al-dia';
  v_clave := substring(v_cmd from 'x-tarea-clave''\s*,\s*''([A-Za-z0-9]+)''');
  if v_clave is null then v_clave := substring(v_cmd from 'clave=([A-Za-z0-9]+)'); end if;
  if v_clave is not null then
    perform cron.schedule('cancelar-flow-huerfanos', '*/15 * * * *',
      format($c$select net.http_get(url := 'https://territorio-whatsapp-bot.onrender.com/tareas/cancelar-flow-huerfanos', headers := jsonb_build_object('x-tarea-clave', %L))$c$, v_clave));
  else
    raise notice 'No se encontro la clave del reloj: programar a mano cancelar-flow-huerfanos (cada 15 min).';
  end if;
end $$;
