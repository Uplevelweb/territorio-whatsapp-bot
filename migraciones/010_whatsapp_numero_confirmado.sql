-- 010 · Numero de WhatsApp CONFIRMADO para recibir las alertas.
-- Hasta ahora el alertador mandaba al `telefono_contacto` (un dato suelto que
-- llega del formulario o del chat, sin confirmar y sin forma de cambiarlo).
-- Ahora: cada suscriptor vincula su WhatsApp desde el panel. El panel entrega
-- un codigo (TERRI-XXXXXX) y la persona lo ENVIA desde ese celular al WhatsApp
-- de Territorio. Que el mensaje llegue desde ese numero prueba que es suyo y
-- deja el opt-in (ademas abre la ventana de 24 h de Meta).
-- El alertador usa SOLO whatsapp_numero + whatsapp_confirmado_en.

alter table public.suscriptores
  add column if not exists whatsapp_numero text,
  add column if not exists whatsapp_confirmado_en timestamptz,
  add column if not exists whatsapp_codigo_hash text,
  add column if not exists whatsapp_codigo_expira timestamptz;

-- Un numero pertenece a una sola cuenta (asi se sabe a quien va cada aviso).
create unique index if not exists suscriptores_whatsapp_numero_uq
  on public.suscriptores (whatsapp_numero) where whatsapp_numero is not null;

create or replace function public._suscriptor_de_token(p_token text)
returns uuid language sql stable security definer set search_path to 'public' as $$
  select id from public.suscriptores
   where sesion_hash = encode(sha256(convert_to(coalesce(p_token,''), 'UTF8')), 'hex')
     and sesion_expira > now() limit 1
$$;
revoke all on function public._suscriptor_de_token(text) from public, anon, authenticated;

-- Estado para la tarjeta del panel (numero enmascarado).
create or replace function public.panel_whatsapp_estado(p_token text)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare v_id uuid; r record;
begin
  v_id := public._suscriptor_de_token(p_token);
  if v_id is null then return jsonb_build_object('ok', false, 'motivo', 'no autorizado'); end if;
  select whatsapp_numero, whatsapp_confirmado_en, whatsapp_codigo_hash, whatsapp_codigo_expira
    into r from public.suscriptores where id = v_id;
  return jsonb_build_object('ok', true,
    'confirmado', r.whatsapp_confirmado_en is not null and r.whatsapp_numero is not null,
    'numero', case when r.whatsapp_numero is null then null
                   else '+' || left(r.whatsapp_numero, 3) || ' ••• ' || right(r.whatsapp_numero, 4) end,
    'pendiente', r.whatsapp_codigo_hash is not null and r.whatsapp_codigo_expira > now(),
    'expira', r.whatsapp_codigo_expira);
end $$;
grant execute on function public.panel_whatsapp_estado(text) to anon, authenticated;

-- Genera un codigo nuevo (30 min). El codigo solo se guarda como huella.
create or replace function public.panel_whatsapp_pedir_codigo(p_token text)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare v_id uuid; v_cod text := 'TERRI-'; v_alf text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; i int;
begin
  v_id := public._suscriptor_de_token(p_token);
  if v_id is null then return jsonb_build_object('ok', false, 'motivo', 'no autorizado'); end if;
  if public._limite_excedido('wa-codigo:' || v_id::text, 5, interval '1 hour') then
    return jsonb_build_object('ok', false, 'motivo', 'Demasiados intentos. Espera un rato.'); end if;
  for i in 1..6 loop v_cod := v_cod || substr(v_alf, 1 + floor(random() * length(v_alf))::int, 1); end loop;
  update public.suscriptores
     set whatsapp_codigo_hash = encode(sha256(convert_to(v_cod, 'UTF8')), 'hex'),
         whatsapp_codigo_expira = now() + interval '30 minutes'
   where id = v_id;
  return jsonb_build_object('ok', true, 'codigo', v_cod, 'expira_min', 30);
end $$;
grant execute on function public.panel_whatsapp_pedir_codigo(text) to anon, authenticated;

create or replace function public.panel_whatsapp_quitar(p_token text)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare v_id uuid;
begin
  v_id := public._suscriptor_de_token(p_token);
  if v_id is null then return jsonb_build_object('ok', false, 'motivo', 'no autorizado'); end if;
  update public.suscriptores
     set whatsapp_numero = null, whatsapp_confirmado_en = null,
         whatsapp_codigo_hash = null, whatsapp_codigo_expira = null
   where id = v_id;
  return jsonb_build_object('ok', true);
end $$;
grant execute on function public.panel_whatsapp_quitar(text) to anon, authenticated;

-- Solo el bot (service_role): llega un mensaje con un codigo desde `p_telefono`.
create or replace function public.bot_confirmar_whatsapp(p_codigo text, p_telefono text)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare v_id uuid; v_nombre text; v_tel text; v_hash text;
begin
  v_tel := regexp_replace(coalesce(p_telefono,''), '\D', '', 'g');
  if v_tel = '' then return jsonb_build_object('ok', false, 'motivo', 'sin_numero'); end if;
  if public._limite_excedido('wa-confirmar:' || v_tel, 8, interval '1 hour') then
    return jsonb_build_object('ok', false, 'motivo', 'demasiados_intentos'); end if;
  v_hash := encode(sha256(convert_to(upper(trim(coalesce(p_codigo,''))), 'UTF8')), 'hex');
  select id, nombre into v_id, v_nombre from public.suscriptores
   where whatsapp_codigo_hash = v_hash and whatsapp_codigo_expira > now() limit 1;
  if v_id is null then return jsonb_build_object('ok', false, 'motivo', 'codigo_invalido'); end if;
  if exists (select 1 from public.suscriptores where whatsapp_numero = v_tel and id <> v_id) then
    return jsonb_build_object('ok', false, 'motivo', 'numero_en_uso'); end if;
  update public.suscriptores
     set whatsapp_numero = v_tel, whatsapp_confirmado_en = now(),
         whatsapp_codigo_hash = null, whatsapp_codigo_expira = null
   where id = v_id;
  return jsonb_build_object('ok', true, 'nombre', v_nombre);
end $$;
revoke all on function public.bot_confirmar_whatsapp(text, text) from public, anon, authenticated;
grant execute on function public.bot_confirmar_whatsapp(text, text) to service_role;
