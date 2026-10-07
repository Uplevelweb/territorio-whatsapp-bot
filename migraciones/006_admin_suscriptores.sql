-- 006 · Suscriptores del panel (solo super admin)
-- Agregar un correo, reenviar la confirmacion y ver si tiene Flow enganchado.
-- NO aplicar sin "PASAR A PRODUCCION".

create or replace function public._es_superadmin(p_token text)
returns boolean language sql security definer set search_path to 'public' as $$
  select exists(
    select 1 from public.suscriptores s
     where s.sesion_hash = encode(sha256(convert_to(coalesce(p_token,''),'UTF8')),'hex')
       and s.sesion_expira > now() and s.rol = 'superadmin');
$$;
revoke all on function public._es_superadmin(text) from public, anon, authenticated;

-- Lista: suma tiene_flow (sin exponer el id de Flow).
drop function if exists public.panel_listar_suscriptores(text);
create function public.panel_listar_suscriptores(p_token text)
returns table(email text, nombre text, plan text, activo boolean, al_dia boolean,
              confirmado_en timestamptz, rol text, proximo_cobro timestamptz,
              tiene_flow boolean, creado_en timestamptz)
language plpgsql security definer set search_path to 'public' as $$
begin
  if not public._es_superadmin(p_token) then raise exception 'no autorizado'; end if;
  return query
    select s.email, s.nombre, s.plan, s.activo, s.al_dia, s.confirmado_en, s.rol,
           s.proximo_cobro, (coalesce(s.flow_subscription_id,'') <> ''), s.creado_en
      from public.suscriptores s
     order by s.confirmado_en desc nulls last, s.creado_en desc;
end $$;
grant execute on function public.panel_listar_suscriptores(text) to anon, authenticated;

-- Agrega un correo y le manda el correo de confirmacion (lo dispara el trigger
-- al_inscribirse). Hasta que no confirme, no entra al flujo.
create or replace function public.panel_agregar_suscriptor(
  p_token text, p_correo text, p_nombre text default null, p_plan text default '')
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare v_correo text := lower(trim(coalesce(p_correo,''))); v_id uuid;
begin
  if not public._es_superadmin(p_token) then
    return jsonb_build_object('ok', false, 'motivo', 'no autorizado'); end if;
  if v_correo !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    return jsonb_build_object('ok', false, 'motivo', 'correo invalido'); end if;
  if coalesce(p_plan,'') not in ('','inicio','plus','premium') then
    return jsonb_build_object('ok', false, 'motivo', 'plan invalido'); end if;
  if exists(select 1 from public.suscriptores where email = v_correo) then
    return jsonb_build_object('ok', false, 'motivo', 'ese correo ya esta registrado'); end if;

  insert into public.suscriptores(email, nombre, plan, activo, origen_consentimiento)
  values (v_correo, nullif(trim(p_nombre),''), nullif(p_plan,''), true, 'alta_admin')
  returning id into v_id;
  insert into public.filtros(suscriptor_id, palabras_clave, regiones, hora_envio,
                             incluye_licitaciones, incluye_compras_agiles, frecuencia)
  values (v_id, '{}', '{}', 8, true, true, 'diaria');
  return jsonb_build_object('ok', true, 'correo', v_correo);
end $$;
grant execute on function public.panel_agregar_suscriptor(text,text,text,text) to anon, authenticated;

-- Reenvia el correo de bienvenida / confirmacion (o es el "correo de prueba").
create or replace function public.panel_reenviar_confirmacion(p_token text, p_correo text)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare v_conf timestamptz; v_ok boolean;
begin
  if not public._es_superadmin(p_token) then
    return jsonb_build_object('ok', false, 'motivo', 'no autorizado'); end if;
  select confirmado_en into v_conf from public.suscriptores where email = lower(trim(p_correo));
  if not found then return jsonb_build_object('ok', false, 'motivo', 'no existe ese correo'); end if;
  if v_conf is not null then
    return jsonb_build_object('ok', false, 'motivo', 'ya confirmo su correo'); end if;
  perform public.enviar_confirmacion(p_correo);
  return jsonb_build_object('ok', true);
end $$;
grant execute on function public.panel_reenviar_confirmacion(text,text) to anon, authenticated;

-- Para el bot (/admin/plan): devuelve el id de la suscripcion de Flow.
create or replace function public.panel_datos_flow(p_token text, p_correo text)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare r record;
begin
  if not public._es_superadmin(p_token) then
    return jsonb_build_object('ok', false, 'motivo', 'no autorizado'); end if;
  select plan, flow_subscription_id into r from public.suscriptores where email = lower(trim(p_correo));
  if not found then return jsonb_build_object('ok', false, 'motivo', 'no existe ese correo'); end if;
  return jsonb_build_object('ok', true, 'plan', r.plan, 'flow_subscription_id', nullif(r.flow_subscription_id,''));
end $$;
grant execute on function public.panel_datos_flow(text,text) to anon, authenticated;
