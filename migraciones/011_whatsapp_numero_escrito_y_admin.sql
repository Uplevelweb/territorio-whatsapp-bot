-- 011 · El cliente ESCRIBE su numero de WhatsApp (en "Configura tus alertas") y el
-- superadmin lo ve / edita desde Suscriptores con la clave del envio masivo.
--  - panel_whatsapp_pedir_codigo(token, numero): valida formato movil chileno y deja el
--    numero "pendiente"; el bot solo confirma si el codigo llega DESDE ESE numero.
--  - panel_admin_whatsapp(token, correo, numero, clave): superadmin fija o quita el numero
--    de un suscriptor (misma clave y mismo limite de intentos que 007/009).
--  - panel_listar_suscriptores devuelve tambien el numero confirmado y el de contacto.

alter table public.suscriptores add column if not exists whatsapp_numero_pendiente text;

create or replace function public._normalizar_movil_cl(p text)
returns text language sql immutable as $$
  select case
    when d ~ '^569\d{8}$' then d
    when d ~ '^9\d{8}$'   then '56' || d
    when d ~ '^09\d{8}$'  then '56' || substr(d, 2)
    else null end
  from (select regexp_replace(coalesce(p,''), '\D', '', 'g') d) x
$$;

drop function if exists public.panel_whatsapp_pedir_codigo(text);
create or replace function public.panel_whatsapp_pedir_codigo(p_token text, p_numero text default null)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare v_id uuid; v_cod text := 'TERRI-'; v_alf text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; i int; v_num text;
begin
  v_id := public._suscriptor_de_token(p_token);
  if v_id is null then return jsonb_build_object('ok', false, 'motivo', 'no autorizado'); end if;
  v_num := public._normalizar_movil_cl(p_numero);
  if v_num is null then
    return jsonb_build_object('ok', false, 'motivo', 'Escribe un celular chileno válido, por ejemplo 9 1234 5678.'); end if;
  if exists (select 1 from public.suscriptores where whatsapp_numero = v_num and id <> v_id) then
    return jsonb_build_object('ok', false, 'motivo', 'Ese número ya está vinculado a otra cuenta.'); end if;
  if public._limite_excedido('wa-codigo:' || v_id::text, 5, interval '1 hour') then
    return jsonb_build_object('ok', false, 'motivo', 'Demasiados intentos. Espera un rato.'); end if;
  for i in 1..6 loop v_cod := v_cod || substr(v_alf, 1 + floor(random() * length(v_alf))::int, 1); end loop;
  update public.suscriptores
     set whatsapp_codigo_hash = encode(sha256(convert_to(v_cod, 'UTF8')), 'hex'),
         whatsapp_codigo_expira = now() + interval '30 minutes',
         whatsapp_numero_pendiente = v_num,
         telefono_contacto = coalesce(telefono_contacto, v_num)
   where id = v_id;
  return jsonb_build_object('ok', true, 'codigo', v_cod, 'expira_min', 30, 'numero', v_num);
end $$;
grant execute on function public.panel_whatsapp_pedir_codigo(text, text) to anon, authenticated;

-- Estado: ademas, el numero que dejo escrito (para precargar el campo).
create or replace function public.panel_whatsapp_estado(p_token text)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare v_id uuid; r record;
begin
  v_id := public._suscriptor_de_token(p_token);
  if v_id is null then return jsonb_build_object('ok', false, 'motivo', 'no autorizado'); end if;
  select whatsapp_numero, whatsapp_confirmado_en, whatsapp_codigo_hash, whatsapp_codigo_expira,
         whatsapp_numero_pendiente, telefono_contacto
    into r from public.suscriptores where id = v_id;
  return jsonb_build_object('ok', true,
    'confirmado', r.whatsapp_confirmado_en is not null and r.whatsapp_numero is not null,
    'numero', case when r.whatsapp_numero is null then null
                   else '+' || left(r.whatsapp_numero, 3) || ' ••• ' || right(r.whatsapp_numero, 4) end,
    'pendiente', r.whatsapp_codigo_hash is not null and r.whatsapp_codigo_expira > now(),
    'expira', r.whatsapp_codigo_expira,
    'numero_escrito', coalesce(r.whatsapp_numero_pendiente, r.telefono_contacto));
end $$;
grant execute on function public.panel_whatsapp_estado(text) to anon, authenticated;

create or replace function public.panel_whatsapp_quitar(p_token text)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare v_id uuid;
begin
  v_id := public._suscriptor_de_token(p_token);
  if v_id is null then return jsonb_build_object('ok', false, 'motivo', 'no autorizado'); end if;
  update public.suscriptores
     set whatsapp_numero = null, whatsapp_confirmado_en = null, whatsapp_numero_pendiente = null,
         whatsapp_codigo_hash = null, whatsapp_codigo_expira = null
   where id = v_id;
  return jsonb_build_object('ok', true);
end $$;
grant execute on function public.panel_whatsapp_quitar(text) to anon, authenticated;

-- El bot confirma SOLO si el codigo llega desde el numero que la persona escribio.
create or replace function public.bot_confirmar_whatsapp(p_codigo text, p_telefono text)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare v_id uuid; v_nombre text; v_tel text; v_hash text; v_pend text;
begin
  v_tel := regexp_replace(coalesce(p_telefono,''), '\D', '', 'g');
  if v_tel = '' then return jsonb_build_object('ok', false, 'motivo', 'sin_numero'); end if;
  if public._limite_excedido('wa-confirmar:' || v_tel, 8, interval '1 hour') then
    return jsonb_build_object('ok', false, 'motivo', 'demasiados_intentos'); end if;
  v_hash := encode(sha256(convert_to(upper(trim(coalesce(p_codigo,''))), 'UTF8')), 'hex');
  select id, nombre, whatsapp_numero_pendiente into v_id, v_nombre, v_pend from public.suscriptores
   where whatsapp_codigo_hash = v_hash and whatsapp_codigo_expira > now() limit 1;
  if v_id is null then return jsonb_build_object('ok', false, 'motivo', 'codigo_invalido'); end if;
  if v_pend is not null and v_pend <> v_tel then
    return jsonb_build_object('ok', false, 'motivo', 'numero_distinto', 'esperado_termina', right(v_pend, 4)); end if;
  if exists (select 1 from public.suscriptores where whatsapp_numero = v_tel and id <> v_id) then
    return jsonb_build_object('ok', false, 'motivo', 'numero_en_uso'); end if;
  update public.suscriptores
     set whatsapp_numero = v_tel, whatsapp_confirmado_en = now(), whatsapp_numero_pendiente = null,
         whatsapp_codigo_hash = null, whatsapp_codigo_expira = null
   where id = v_id;
  return jsonb_build_object('ok', true, 'nombre', v_nombre);
end $$;
revoke all on function public.bot_confirmar_whatsapp(text, text) from public, anon, authenticated;
grant execute on function public.bot_confirmar_whatsapp(text, text) to service_role;

-- Superadmin: fija o quita el numero de un suscriptor (clave del envio masivo).
create or replace function public.panel_admin_whatsapp(p_token text, p_correo_objetivo text, p_numero text, p_clave text)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare v_num text; v_id uuid;
begin
  if not public._es_superadmin(p_token) then return jsonb_build_object('ok', false, 'motivo', 'no autorizado'); end if;
  if (select count(*) from public.limite_eventos
       where clave = 'borrar:fallo' and cuando > now() - interval '15 minutes') >= 5 then
    return jsonb_build_object('ok', false, 'motivo', 'Demasiados intentos con clave incorrecta. Espera unos minutos.'); end if;
  if encode(sha256(convert_to(upper(trim(coalesce(p_clave,''))), 'UTF8')), 'hex')
     is distinct from '33c7b828710e5c9dfb98949e6b72183cc03a1cbbd25473132042ee634b222a07' then
    insert into public.limite_eventos(clave) values ('borrar:fallo');
    return jsonb_build_object('ok', false, 'motivo', 'Clave incorrecta.'); end if;
  select id into v_id from public.suscriptores where email = lower(trim(p_correo_objetivo));
  if v_id is null then return jsonb_build_object('ok', false, 'motivo', 'no existe ese correo'); end if;
  if coalesce(trim(p_numero),'') = '' then
    update public.suscriptores
       set whatsapp_numero = null, whatsapp_confirmado_en = null, whatsapp_numero_pendiente = null,
           whatsapp_codigo_hash = null, whatsapp_codigo_expira = null
     where id = v_id;
    return jsonb_build_object('ok', true, 'numero', null);
  end if;
  v_num := public._normalizar_movil_cl(p_numero);
  if v_num is null then return jsonb_build_object('ok', false, 'motivo', 'Número inválido: debe ser un celular chileno (9 XXXX XXXX).'); end if;
  if exists (select 1 from public.suscriptores where whatsapp_numero = v_num and id <> v_id) then
    return jsonb_build_object('ok', false, 'motivo', 'Ese número ya está en otra cuenta.'); end if;
  update public.suscriptores
     set whatsapp_numero = v_num, whatsapp_confirmado_en = now(), whatsapp_numero_pendiente = null,
         telefono_contacto = coalesce(telefono_contacto, v_num),
         whatsapp_codigo_hash = null, whatsapp_codigo_expira = null
   where id = v_id;
  return jsonb_build_object('ok', true, 'numero', v_num);
end $$;
grant execute on function public.panel_admin_whatsapp(text, text, text, text) to anon, authenticated;

-- Lista de suscriptores con el numero de WhatsApp (solo superadmin, igual que antes).
drop function if exists public.panel_listar_suscriptores(text);
create function public.panel_listar_suscriptores(p_token text)
returns table(email text, nombre text, plan text, activo boolean, al_dia boolean, confirmado_en timestamptz,
              rol text, proximo_cobro timestamptz, tiene_flow boolean, creado_en timestamptz,
              whatsapp_numero text, whatsapp_confirmado_en timestamptz, telefono_contacto text)
language plpgsql security definer set search_path to 'public' as $$
begin
  if not public._es_superadmin(p_token) then raise exception 'no autorizado'; end if;
  return query
    select s.email, s.nombre, s.plan, s.activo, s.al_dia, s.confirmado_en, s.rol,
           s.proximo_cobro, (coalesce(s.flow_subscription_id,'') <> ''), s.creado_en,
           s.whatsapp_numero, s.whatsapp_confirmado_en, s.telefono_contacto
      from public.suscriptores s
     order by s.confirmado_en desc nulls last, s.creado_en desc;
end $$;
grant execute on function public.panel_listar_suscriptores(text) to anon, authenticated;
