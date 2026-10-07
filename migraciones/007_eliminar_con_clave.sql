-- 007 · Eliminar suscriptor pide la clave de confirmación (la misma del envío masivo).
-- La clave NO se guarda: solo su huella (sha256, en mayúsculas y sin espacios).
-- Con 5 intentos fallidos en 15 minutos se bloquea un rato.
drop function if exists public.panel_eliminar_suscriptor(text, text);
create function public.panel_eliminar_suscriptor(p_token text, p_correo_objetivo text, p_clave text default null)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare
  v_correo  text; v_id uuid; v_rol_obj text; v_plan text; v_flow_id text;
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
  select id, rol, plan, flow_customer_id into v_id, v_rol_obj, v_plan, v_flow_id
    from public.suscriptores where email = v_correo;
  if v_id is null then return jsonb_build_object('ok', false, 'motivo', 'no existe ese correo'); end if;
  if v_rol_obj = 'superadmin' then
    return jsonb_build_object('ok', false, 'motivo', 'no se puede eliminar a un super admin'); end if;
  if coalesce(v_plan, '') <> '' or coalesce(v_flow_id, '') <> '' then
    return jsonb_build_object('ok', false,
      'motivo', 'tiene un plan pagado o una suscripcion de Flow enganchada: desactivalo con el casillero Activo, eliminarlo no cancela el cobro'); end if;

  delete from public.filtros where suscriptor_id = v_id;
  delete from public.suscriptores where id = v_id;
  return jsonb_build_object('ok', true, 'correo', v_correo);
end $$;
grant execute on function public.panel_eliminar_suscriptor(text, text, text) to anon, authenticated;
