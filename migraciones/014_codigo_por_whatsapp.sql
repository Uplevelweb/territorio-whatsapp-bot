-- 014 · Confirmacion del WhatsApp con codigo ENVIADO POR WHATSAPP (plantilla de Autenticacion de Meta).
-- Cambia el sentido del proceso (decision 09-10-2026, a pedido de Serling, siguiendo a Meta):
--   1) la persona escribe su celular en "Configura tus alertas" y pulsa "Enviar codigo";
--   2) Terri le manda un correo avisando que se inicio la configuracion (SIN codigo);
--   3) el bot (service_role) genera el codigo y lo envia al celular por WhatsApp;
--   4) la persona escribe ese codigo en el panel y queda confirmada.
-- El codigo dura 15 minutos, se guarda solo hasheado, y el panel nunca lo recibe: solo llega al celular.
-- Maximo 6 intentos de codigo cada 15 minutos por persona.
-- Los pasos 1-2 son panel_whatsapp_pedir_codigo; el 3, bot_generar_codigo_whatsapp; el 4, panel_whatsapp_confirmar_codigo.

-- 1-2) El panel solo deja el numero "pendiente" y manda el correo (sin codigo).
create or replace function public.panel_whatsapp_pedir_codigo(p_token text, p_numero text default null)
returns jsonb language plpgsql security definer
set search_path to 'public', 'net', 'extensions', 'vault' as $$
declare v_id uuid; v_num text; v_mail text; v_nombre text; v_llave text; v_cuerpo text; v_visible text;
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
  -- Un codigo anterior deja de valer: el que llegue por WhatsApp sera el nuevo.
  update public.suscriptores
     set whatsapp_codigo_hash = null, whatsapp_codigo_expira = null,
         whatsapp_numero_pendiente = v_num,
         telefono_contacto = coalesce(telefono_contacto, v_num)
   where id = v_id
   returning email, nombre into v_mail, v_nombre;

  -- Correo de Terri: avisa que se inicio la configuracion (nunca debe romper el proceso).
  begin
    select decrypted_secret into v_llave from vault.decrypted_secrets where name = 'resend_api_key';
    if v_llave is not null and v_mail is not null then
      v_visible := '+' || left(v_num, 2) || ' ' || substr(v_num, 3, 1) || ' ' || substr(v_num, 4, 4) || ' ' || substr(v_num, 8);
      v_cuerpo := format($html$
<table width="100%%" cellpadding="0" cellspacing="0" border="0" style="background:#f4f6fa;padding:26px 14px;">
 <tr><td align="center">
  <table width="900" cellpadding="0" cellspacing="0" border="0" style="max-width:900px;background:#ffffff;border-radius:12px;">
   <tr><td style="background:#ffffff;border-radius:12px 12px 0 0;padding:18px 22px 0;">
     <div style="color:#0c2c57;font-size:18px;font-weight:700;font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;">Territorio &middot; Sistema Inteligente de Alertas</div>
   </td></tr>
   <tr><td style="height:3px;background:#f18c3f;font-size:0;line-height:0;">&nbsp;</td></tr>
   <tr><td style="padding:24px 22px 26px;font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#1a2b3d;font-size:16.5px;line-height:1.55;">
     <div style="font-size:20px;font-weight:700;color:#0c2c57;">Iniciaste la configuraci&oacute;n de tu WhatsApp</div>
     <div style="padding-top:12px;">Hola%s: soy Terri. Desde tu panel pediste vincular el n&uacute;mero <strong>%s</strong> para recibir tu aviso diario por WhatsApp.</div>
     <div style="padding-top:14px;">Te acabo de enviar <strong>un c&oacute;digo de verificaci&oacute;n por WhatsApp</strong> a ese n&uacute;mero. Para confirmarlo:</div>
     <div style="padding-top:10px;">
       <div style="padding:4px 0;"><strong>1.</strong> Abre el mensaje de WhatsApp y copia el c&oacute;digo.</div>
       <div style="padding:4px 0;"><strong>2.</strong> Vuelve a tu panel, en <strong>Configura tus alertas (Email y WhatsApp)</strong>, y p&eacute;galo en el campo de c&oacute;digo.</div>
     </div>
     <div style="padding-top:14px;"><strong>El c&oacute;digo dura 15 minutos.</strong> Si vence, genera uno nuevo desde tu panel. Mientras no lo confirmes, no te enviaremos alertas por WhatsApp; tu aviso por correo sigue igual.</div>
     <div style="padding-top:18px;font-size:13.5px;color:#6b7c8f;">Si no fuiste t&uacute;, ignora este correo: sin ese c&oacute;digo no se vincula nada. Por seguridad, este correo no incluye el c&oacute;digo.</div>
   </td></tr>
  </table>
 </td></tr>
</table>$html$,
        case when coalesce(trim(v_nombre),'') = '' then '' else ' ' || split_part(trim(v_nombre), ' ', 1) end,
        v_visible);
      perform http_post(
        url := 'https://api.resend.com/emails',
        body := jsonb_build_object(
          'from', 'Territorio <alertas@territorio.uplevelweb.art>',
          'to', jsonb_build_array(v_mail),
          'subject', 'Terri: iniciaste la configuración de tu WhatsApp',
          'html', v_cuerpo),
        headers := jsonb_build_object('Authorization', 'Bearer ' || v_llave, 'Content-Type', 'application/json'));
    end if;
  exception when others then
    null;
  end;

  return jsonb_build_object('ok', true, 'expira_min', 15, 'numero', v_num);
end $$;
grant execute on function public.panel_whatsapp_pedir_codigo(text, text) to anon, authenticated;

-- 3) El bot genera el codigo y lo recibe en claro SOLO para enviarlo por WhatsApp.
create or replace function public.bot_generar_codigo_whatsapp(p_token text)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare v_id uuid; v_cod text := ''; v_alf text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; i int; r record;
begin
  v_id := public._suscriptor_de_token(p_token);
  if v_id is null then return jsonb_build_object('ok', false, 'motivo', 'no autorizado'); end if;
  select nombre, whatsapp_numero_pendiente into r from public.suscriptores where id = v_id;
  if r.whatsapp_numero_pendiente is null then return jsonb_build_object('ok', false, 'motivo', 'sin_numero'); end if;
  if public._limite_excedido('wa-aviso:' || v_id::text, 3, interval '1 hour') then
    return jsonb_build_object('ok', false, 'motivo', 'demasiados_avisos'); end if;
  for i in 1..6 loop v_cod := v_cod || substr(v_alf, 1 + floor(random() * length(v_alf))::int, 1); end loop;
  update public.suscriptores
     set whatsapp_codigo_hash = encode(sha256(convert_to(v_cod, 'UTF8')), 'hex'),
         whatsapp_codigo_expira = now() + interval '15 minutes'
   where id = v_id;
  return jsonb_build_object('ok', true, 'codigo', v_cod, 'numero', r.whatsapp_numero_pendiente, 'nombre', r.nombre);
end $$;
revoke all on function public.bot_generar_codigo_whatsapp(text) from public, anon, authenticated;
grant execute on function public.bot_generar_codigo_whatsapp(text) to service_role;

-- 4) La persona escribe en el panel el codigo que le llego por WhatsApp.
create or replace function public.panel_whatsapp_confirmar_codigo(p_token text, p_codigo text)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare v_id uuid; r record; v_hash text;
begin
  v_id := public._suscriptor_de_token(p_token);
  if v_id is null then return jsonb_build_object('ok', false, 'motivo', 'no autorizado'); end if;
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
  update public.suscriptores
     set whatsapp_numero = r.whatsapp_numero_pendiente, whatsapp_confirmado_en = now(),
         whatsapp_numero_pendiente = null, whatsapp_codigo_hash = null, whatsapp_codigo_expira = null
   where id = v_id;
  return jsonb_build_object('ok', true);
end $$;
grant execute on function public.panel_whatsapp_confirmar_codigo(text, text) to anon, authenticated;

-- Ya no se usan: el codigo no viaja del celular al bot ni el bot "avisa" sin codigo.
drop function if exists public.bot_aviso_codigo_whatsapp(text);
drop function if exists public.bot_confirmar_whatsapp(text, text);
