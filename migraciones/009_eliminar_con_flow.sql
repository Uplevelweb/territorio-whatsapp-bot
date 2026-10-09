-- 009 · Eliminar suscriptor TAMBIEN cuando tiene plan / suscripcion en Flow.
-- El panel ya no borra directo: llama al bot (/admin/eliminar-suscriptor), que
--   1) pide a esta base validar token + clave   -> panel_preparar_borrado
--   2) cancela la suscripcion en Flow (si hay)
--   3) recien entonces borra al usuario          -> bot_borrar_suscriptor
-- Si Flow falla, NO se borra nada: nunca queda un cobro huerfano.
-- La clave es la misma de 007 (solo se guarda su huella) y comparte el limite
-- de 5 intentos fallidos en 15 minutos.

create or replace function public.panel_preparar_borrado(p_token text, p_correo_objetivo text, p_clave text default null)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare
  v_correo text; v_id uuid; v_rol_obj text; v_plan text; v_sub text; v_cli text;
begin
  if not public._es_superadmin(p_token) then
    return jsonb_build_object('ok', false, 'motivo', 'no autorizado'); end if;

  if (select count(*) from public.limite_eventos
       where clave = 'borrar:fallo' and cuando > now() - interval '15 minutes') >= 5 then
    return jsonb_build_object('ok', false, 'motivo', 'Demasiados intentos con clave incorrecta. Espera unos minutos.'); end if;

  if encode(sha256(convert_to(upper(trim(coalesce(p_clave,''))), 'UTF8')), 'hex')
     is distinct from '33c7b828710e5c9dfb98949e6b72183cc03a1cbbd25473132042ee634b222a07' then
    insert into public.limite_eventos(clave) values ('borrar:fallo');
    return jsonb_build_object('ok', false, 'motivo', 'Clave incorrecta.'); end if;

  v_correo := lower(trim(p_correo_objetivo));
  select id, rol, plan, nullif(flow_subscription_id,''), nullif(flow_customer_id,'')
    into v_id, v_rol_obj, v_plan, v_sub, v_cli
    from public.suscriptores where email = v_correo;
  if v_id is null then return jsonb_build_object('ok', false, 'motivo', 'no existe ese correo'); end if;
  if v_rol_obj = 'superadmin' then
    return jsonb_build_object('ok', false, 'motivo', 'no se puede eliminar a un super admin'); end if;

  return jsonb_build_object('ok', true, 'correo', v_correo,
    'plan', v_plan, 'flow_subscription_id', v_sub, 'flow_customer_id', v_cli);
end $$;
grant execute on function public.panel_preparar_borrado(text, text, text) to anon, authenticated;

-- Solo el bot (service_role) puede borrar de verdad. Los hijos (filtros, envios,
-- rubros, contactos) caen solos por ON DELETE CASCADE.
create or replace function public.bot_borrar_suscriptor(p_correo text)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare v_id uuid; v_rol text;
begin
  select id, rol into v_id, v_rol from public.suscriptores where email = lower(trim(p_correo));
  if v_id is null then return jsonb_build_object('ok', false, 'motivo', 'no existe ese correo'); end if;
  if v_rol = 'superadmin' then return jsonb_build_object('ok', false, 'motivo', 'no se puede eliminar a un super admin'); end if;
  delete from public.suscriptores where id = v_id;
  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.bot_borrar_suscriptor(text) from public, anon, authenticated;
grant execute on function public.bot_borrar_suscriptor(text) to service_role;
