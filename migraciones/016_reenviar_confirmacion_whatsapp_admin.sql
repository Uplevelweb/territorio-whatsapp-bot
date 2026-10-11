-- 016 · Super Admin puede reenviar la confirmación de WhatsApp (correo + WhatsApp) las veces que haga falta.
-- Pedido de Serling el 11-10-2026: probó asignar un número desde Super Admin y no salió ninguna confirmación.
--
-- Regla de envíos (no cambia): solo mandan mensaje/correo las ALTAS y las CONFIRMACIONES (de correo o de
-- WhatsApp) y este reenvío manual. ELIMINAR un suscriptor o QUITAR un número no manda nada: no hay trigger de
-- borrado y ninguna de esas funciones llama a Resend ni al bot.

-- 1) El correo "tus alertas por WhatsApp quedaron configuradas", en UNA sola función para que el alta
--    normal (panel_whatsapp_confirmar_codigo) y el reenvío del Super Admin no se desincronicen.
create or replace function public._correo_wa_configurado(p_id uuid)
returns boolean language plpgsql security definer
set search_path to 'public', 'net', 'extensions', 'vault' as $$
declare v_mail text; v_nombre text; v_num text; v_llave text; v_visible text; v_pres text; v_cuerpo text;
begin
  select email, nombre, whatsapp_numero into v_mail, v_nombre, v_num from public.suscriptores where id = p_id;
  if v_mail is null or v_num is null then return false; end if;
  select decrypted_secret into v_llave from vault.decrypted_secrets where name = 'resend_api_key';
  if v_llave is null then return false; end if;
  v_visible := '+' || left(v_num, 2) || ' ' || substr(v_num, 3, 1) || ' ' || substr(v_num, 4, 4) || ' ' || substr(v_num, 8);
  v_pres := case when coalesce(trim(v_nombre),'') = '' then 'Hola, soy Terri, el Asistente Inteligente de Territorio.'
                 else 'Hola ' || split_part(trim(v_nombre), ' ', 1) || ', soy Terri, el Asistente Inteligente de Territorio.' end;
  v_cuerpo := public._correo_terri(
    '✓ Tus alertas por WhatsApp quedaron configuradas',
    'Número confirmado: ' || v_visible || ' · ' || to_char(now() at time zone 'America/Santiago', 'DD-MM-YYYY'),
    '<strong>' || v_pres || '</strong> Confirmé tu número <strong>' || v_visible
      || '</strong>: desde ahora te escribo por WhatsApp.',
    '<div style="color:#2c3e50;font-size:15px;font-weight:700;margin-bottom:8px;">Qué vas a recibir</div>'
    || '<div style="margin-bottom:14px;">Cada día, <strong>en ese WhatsApp</strong>, un aviso corto con cuántas oportunidades hay para ti. '
    || 'El detalle completo sigue llegando a tu correo, igual que siempre.</div>'
    || '<div style="color:#2c3e50;font-size:13px;border-left:3px solid #1f9d55;padding-left:12px;margin-bottom:14px;">'
    || '<strong>Tu número quedó fijo.</strong> Por seguridad no se puede cambiar desde el panel. Si algún día necesitas cambiarlo, escribe a soporte.</div>'
    || '<a href="https://wa.me/56967329214?text=Quiero%20cambiar%20mi%20n%C3%BAmero%20de%20WhatsApp%20de%20alertas" style="display:inline-block;background:#f18c3f;color:#0c2c57;text-decoration:none;font-size:14px;font-weight:700;padding:11px 22px;border-radius:999px;">Escribir a soporte</a>'
    || '<div style="color:#6b7c8f;font-size:12px;margin-top:14px;">Si no fuiste tú quien lo configuró, escríbenos ahora por el botón de arriba.</div>');
  perform http_post(
    url := 'https://api.resend.com/emails',
    body := jsonb_build_object(
      'from', 'Territorio <alertas@territorio.uplevelweb.art>',
      'to', jsonb_build_array(v_mail),
      'subject', 'Terri: tus alertas por WhatsApp quedaron configuradas',
      'html', v_cuerpo),
    headers := jsonb_build_object('Authorization', 'Bearer ' || v_llave, 'Content-Type', 'application/json'));
  return true;
exception when others then
  return false;
end $$;
revoke all on function public._correo_wa_configurado(uuid) from public, anon, authenticated;

-- 2) El alta normal usa la misma función (antes tenía el correo escrito adentro).
create or replace function public.panel_whatsapp_confirmar_codigo(p_token text, p_codigo text)
returns jsonb language plpgsql security definer
set search_path to 'public', 'net', 'extensions', 'vault' as $$
declare v_id uuid; r record; v_hash text; v_num text;
begin
  v_id := public._suscriptor_de_token(p_token);
  if v_id is null then return jsonb_build_object('ok', false, 'motivo', 'no autorizado'); end if;
  if public._wa_fijo(v_id) then
    return jsonb_build_object('ok', false, 'motivo', public._wa_texto_fijo(), 'fijo', true); end if;
  if public._limite_excedido('wa-intento:' || v_id::text, 6, interval '15 minutes') then
    return jsonb_build_object('ok', false, 'motivo', 'Demasiados intentos. Espera unos minutos y genera un código nuevo.'); end if;
  select whatsapp_numero_pendiente, whatsapp_codigo_hash, whatsapp_codigo_expira
    into r from public.suscriptores where id = v_id;
  if r.whatsapp_codigo_hash is null or r.whatsapp_numero_pendiente is null then
    return jsonb_build_object('ok', false, 'motivo', 'Primero pide el código con tu número.'); end if;
  if r.whatsapp_codigo_expira <= now() then
    return jsonb_build_object('ok', false, 'motivo', 'El código venció (dura 15 minutos). Genera uno nuevo.'); end if;
  v_hash := encode(sha256(convert_to(upper(regexp_replace(coalesce(p_codigo,''), '\s', '', 'g')), 'UTF8')), 'hex');
  if v_hash <> r.whatsapp_codigo_hash then
    return jsonb_build_object('ok', false, 'motivo', 'Ese código no coincide. Revisa el mensaje de WhatsApp.'); end if;
  if exists (select 1 from public.suscriptores where whatsapp_numero = r.whatsapp_numero_pendiente and id <> v_id) then
    return jsonb_build_object('ok', false, 'motivo', 'Ese número ya está vinculado a otra cuenta.'); end if;
  v_num := r.whatsapp_numero_pendiente;
  update public.suscriptores
     set whatsapp_numero = v_num, whatsapp_confirmado_en = now(),
         whatsapp_numero_pendiente = null, whatsapp_codigo_hash = null, whatsapp_codigo_expira = null,
         whatsapp_confirmacion_avisada_en = null
   where id = v_id;
  perform public._correo_wa_configurado(v_id);
  return jsonb_build_object('ok', true);
end $$;

-- 3) Reenvío del Super Admin: correo + datos para que el bot mande el WhatsApp. Sin tope de veces ni de
--    tiempo (el aviso normal es de una sola vez; este es manual). Solo service_role: lo llama el bot.
create or replace function public.bot_admin_reenviar_confirmacion_whatsapp(p_token text, p_correo text)
returns jsonb language plpgsql security definer
set search_path to 'public', 'net', 'extensions', 'vault' as $$
declare v_id uuid; r record; v_correo_ok boolean;
begin
  if not public._es_superadmin(p_token) then
    return jsonb_build_object('ok', false, 'motivo', 'no autorizado'); end if;
  select id, whatsapp_numero, whatsapp_confirmado_en, nombre into r
    from public.suscriptores where email = lower(trim(p_correo));
  if r.id is null then return jsonb_build_object('ok', false, 'motivo', 'no existe ese correo'); end if;
  if r.whatsapp_numero is null or r.whatsapp_confirmado_en is null then
    return jsonb_build_object('ok', false, 'motivo', 'Esa cuenta no tiene un WhatsApp confirmado. Guárdalo primero.'); end if;
  v_correo_ok := public._correo_wa_configurado(r.id);
  update public.suscriptores set whatsapp_confirmacion_avisada_en = now() where id = r.id;
  return jsonb_build_object('ok', true, 'numero', r.whatsapp_numero, 'nombre', r.nombre, 'correo_enviado', v_correo_ok);
end $$;
revoke all on function public.bot_admin_reenviar_confirmacion_whatsapp(text, text) from public, anon, authenticated;
grant execute on function public.bot_admin_reenviar_confirmacion_whatsapp(text, text) to service_role;
