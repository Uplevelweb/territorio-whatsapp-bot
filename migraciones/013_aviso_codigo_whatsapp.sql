-- 013 · Terri tambien escribe POR WHATSAPP cuando alguien inicia la configuracion de su numero.
-- El bot (service_role) pregunta aqui a quien avisar: valida la sesion del panel, que haya un
-- codigo vigente y devuelve el numero que la persona escribio (nunca el codigo: solo se guarda hasheado).
-- Maximo 3 avisos por hora por persona.
create or replace function public.bot_aviso_codigo_whatsapp(p_token text)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare v_id uuid; r record;
begin
  v_id := public._suscriptor_de_token(p_token);
  if v_id is null then return jsonb_build_object('ok', false, 'motivo', 'no autorizado'); end if;
  select nombre, whatsapp_numero_pendiente, whatsapp_codigo_hash, whatsapp_codigo_expira
    into r from public.suscriptores where id = v_id;
  if r.whatsapp_codigo_hash is null or r.whatsapp_codigo_expira <= now() or r.whatsapp_numero_pendiente is null then
    return jsonb_build_object('ok', false, 'motivo', 'sin_codigo_vigente'); end if;
  if public._limite_excedido('wa-aviso:' || v_id::text, 3, interval '1 hour') then
    return jsonb_build_object('ok', false, 'motivo', 'demasiados_avisos'); end if;
  return jsonb_build_object('ok', true, 'numero', r.whatsapp_numero_pendiente, 'nombre', r.nombre);
end $$;
revoke all on function public.bot_aviso_codigo_whatsapp(text) from public, anon, authenticated;
grant execute on function public.bot_aviso_codigo_whatsapp(text) to service_role;
