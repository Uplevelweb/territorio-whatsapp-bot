-- 015 · WhatsApp: numero FIJO una vez confirmado + aviso de "configurado" + correos al cliente con el diseno del correo de alertas.
-- Decisiones de Serling (09-10-2026):
--   1) Una vez confirmado el numero de WhatsApp queda fijo: el cliente NO puede cambiarlo ni quitarlo.
--      Solo el soporte (super admin, panel_admin_whatsapp) lo puede editar. Evita el mal uso del WhatsApp.
--   2) Al confirmar se avisa por correo (esta migracion) y por WhatsApp (plantilla de Meta, lo manda el bot).
--   3) Todos los correos al cliente usan el mismo diseno, letra y ancho que el correo de alertas
--      (encabezado azul con Terri, tarjeta a todo el ancho, mismo pie).
-- Se aplica una sola vez, despues de 014. Todo es "create or replace": se puede repetir sin dano.

alter table public.suscriptores add column if not exists whatsapp_confirmacion_avisada_en timestamptz;

-- ========== Marco unico de los correos al cliente (copia fiel del de alertador.armar_correo) ==========
create or replace function public._correo_terri(p_titulo text, p_resumen text, p_saludo text, p_cuerpo text)
returns text language sql immutable set search_path to 'public' as $f$
select $h$<!DOCTYPE html>
<html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light">
<style>
  body,table,td{-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%}
  body,table,td,div,p,span,a,strong,b,small,h1,h2,h3,h4{font-family:'Segoe UI',-apple-system,BlinkMacSystemFont,Roboto,'Helvetica Neue',Arial,sans-serif}
</style>
</head>
<body style="margin:0;padding:0;background:#f5f7fa;font-family:'Segoe UI',-apple-system,BlinkMacSystemFont,Roboto,'Helvetica Neue',Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f5f7fa;padding:14px 4px 14px 0;">
<tr><td align="center">
<table width="100%" cellpadding="0" cellspacing="0" border="0"
       style="background:#ffffff;border-radius:12px;overflow:hidden;max-width:600px;width:100%;font-family:'Segoe UI',-apple-system,BlinkMacSystemFont,Roboto,'Helvetica Neue',Arial,sans-serif;">
  <tr>
    <td style="background:#0c2c57;padding:14px 12px 16px;">
      <div style="color:#f18c3f;font-size:12px;font-weight:700;letter-spacing:.02em;">Territorio · Sistema Inteligente de Alerta - Mercado Público</div>
      <div style="color:#ffffff;font-size:20px;font-weight:700;margin:3px 0 2px;">$h$
  || coalesce(p_titulo, '') ||
$h$</div>
      <div style="color:#cbd5e1;font-size:12.5px;line-height:1.5;">$h$ || coalesce(p_resumen, '') || $h$</div>
      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#1a3d6b;border-radius:10px;margin-top:10px;">
        <tr>
          <td width="56" style="padding:8px 0 8px 10px;line-height:0;">
            <img src="https://territorio.uplevelweb.art/img/terri.png" alt="Terri" width="44" height="44"
                 style="display:block;border:0;background:#eaf2fb;border-radius:22px;"></td>
          <td style="padding:8px 12px;color:#e6edf6;font-size:12.5px;line-height:1.45;">$h$ || coalesce(p_saludo, '') || $h$</td>
        </tr>
      </table>
    </td>
  </tr>
  <tr>
    <td style="padding:14px 10px 20px 12px;">
      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f6f8fb;border:1px solid #e1e8ed;border-radius:12px;">
        <tr><td style="padding:18px 20px;color:#2c3e50;font-size:13.5px;line-height:1.6;">$h$ || coalesce(p_cuerpo, '') || $h$</td></tr>
      </table>
    </td>
  </tr>
  <tr>
    <td style="padding:6px 12px 24px;border-top:1px solid #e1e8ed;">
      <div style="color:#6b7c8f;font-size:11px;line-height:1.7;padding-top:14px;">
        <strong>No respondas este correo</strong>, nadie lo lee. ¿Necesitas soporte?
        <a href="https://wa.me/56967329214?text=Necesito%20soporte" style="color:#0c2c57;font-weight:600;">Escríbenos por WhatsApp</a>.<br><br>
        Uplevel · 77.082.051-0 · Santiago, Chile
      </div>
    </td>
  </tr>
</table>
</td></tr></table>
</body></html>$h$;
$f$;
revoke all on function public._correo_terri(text,text,text,text) from public, anon, authenticated;

-- ========== Numero fijo ==========
create or replace function public._wa_fijo(p_id uuid)
returns boolean language sql stable security definer set search_path to 'public' as $$
  select coalesce((select whatsapp_numero is not null and whatsapp_confirmado_en is not null
                     from public.suscriptores where id = p_id), false);
$$;
revoke all on function public._wa_fijo(uuid) from public, anon, authenticated;

create or replace function public._wa_texto_fijo()
returns text language sql immutable as $$
  select 'Por seguridad, tu número de WhatsApp quedó fijo y no se puede cambiar desde el panel. Si necesitas cambiarlo, escribe a soporte.';
$$;

-- Estado para pintar la tarjeta (agrega: fijo y su texto).
create or replace function public.panel_whatsapp_estado(p_token text)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare v_id uuid; r record; v_fijo boolean;
begin
  v_id := public._suscriptor_de_token(p_token);
  if v_id is null then return jsonb_build_object('ok', false, 'motivo', 'no autorizado'); end if;
  select whatsapp_numero, whatsapp_confirmado_en, whatsapp_codigo_hash, whatsapp_codigo_expira,
         whatsapp_numero_pendiente, telefono_contacto
    into r from public.suscriptores where id = v_id;
  v_fijo := public._wa_fijo(v_id);
  return jsonb_build_object('ok', true,
    'confirmado', r.whatsapp_confirmado_en is not null and r.whatsapp_numero is not null,
    'numero', case when r.whatsapp_numero is null then null
                   else '+' || left(r.whatsapp_numero, 3) || ' ••• ' || right(r.whatsapp_numero, 4) end,
    'pendiente', r.whatsapp_codigo_hash is not null and r.whatsapp_codigo_expira > now(),
    'expira', r.whatsapp_codigo_expira,
    'numero_escrito', coalesce(r.whatsapp_numero_pendiente, r.telefono_contacto),
    'fijo', v_fijo,
    'fijo_texto', case when v_fijo then public._wa_texto_fijo() else null end);
end $$;

-- Quitar / cambiar: ya no se puede una vez confirmado (solo soporte, con panel_admin_whatsapp).
create or replace function public.panel_whatsapp_quitar(p_token text)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare v_id uuid;
begin
  v_id := public._suscriptor_de_token(p_token);
  if v_id is null then return jsonb_build_object('ok', false, 'motivo', 'no autorizado'); end if;
  if public._wa_fijo(v_id) then
    return jsonb_build_object('ok', false, 'motivo', public._wa_texto_fijo(), 'fijo', true); end if;
  update public.suscriptores
     set whatsapp_numero = null, whatsapp_confirmado_en = null, whatsapp_numero_pendiente = null,
         whatsapp_codigo_hash = null, whatsapp_codigo_expira = null, whatsapp_confirmacion_avisada_en = null
   where id = v_id;
  return jsonb_build_object('ok', true);
end $$;

-- Pedir codigo: con numero ya confirmado se rechaza; si no, igual que antes pero con el correo nuevo.
create or replace function public.panel_whatsapp_pedir_codigo(p_token text, p_numero text default null)
returns jsonb language plpgsql security definer
set search_path to 'public', 'net', 'extensions', 'vault' as $$
declare v_id uuid; v_num text; v_mail text; v_nombre text; v_llave text; v_cuerpo text; v_visible text; v_pres text;
begin
  v_id := public._suscriptor_de_token(p_token);
  if v_id is null then return jsonb_build_object('ok', false, 'motivo', 'no autorizado'); end if;
  if public._wa_fijo(v_id) then
    return jsonb_build_object('ok', false, 'motivo', public._wa_texto_fijo(), 'fijo', true); end if;
  v_num := public._normalizar_movil_cl(p_numero);
  if v_num is null then
    return jsonb_build_object('ok', false, 'motivo', 'Escribe un celular chileno válido, por ejemplo 9 1234 5678.'); end if;
  if exists (select 1 from public.suscriptores where whatsapp_numero = v_num and id <> v_id) then
    return jsonb_build_object('ok', false, 'motivo', 'Ese número ya está vinculado a otra cuenta.'); end if;
  if public._limite_excedido('wa-codigo:' || v_id::text, 5, interval '1 hour') then
    return jsonb_build_object('ok', false, 'motivo', 'Demasiados intentos. Espera un rato.'); end if;
  update public.suscriptores
     set whatsapp_codigo_hash = null, whatsapp_codigo_expira = null,
         whatsapp_numero_pendiente = v_num,
         telefono_contacto = coalesce(telefono_contacto, v_num)
   where id = v_id
   returning email, nombre into v_mail, v_nombre;
  begin
    select decrypted_secret into v_llave from vault.decrypted_secrets where name = 'resend_api_key';
    if v_llave is not null and v_mail is not null then
      v_visible := '+' || left(v_num, 2) || ' ' || substr(v_num, 3, 1) || ' ' || substr(v_num, 4, 4) || ' ' || substr(v_num, 8);
      v_pres := case when coalesce(trim(v_nombre),'') = '' then 'Hola, soy Terri, el Asistente Inteligente de Territorio.'
                     else 'Hola ' || split_part(trim(v_nombre), ' ', 1) || ', soy Terri, el Asistente Inteligente de Territorio.' end;
      v_cuerpo := public._correo_terri(
        'Iniciaste la configuración de tu WhatsApp',
        'Te enviamos un código de verificación a ' || v_visible,
        '<strong>' || v_pres || '</strong> Pediste vincular el número <strong>' || v_visible
          || '</strong> para recibir tu resumen diario por WhatsApp.',
        '<div style="color:#2c3e50;font-size:15px;font-weight:700;margin-bottom:8px;">Termina en dos pasos</div>'
        || '<div style="margin-bottom:14px;"><strong>1.</strong> Abre el mensaje de WhatsApp y copia el código.<br>'
        || '<strong>2.</strong> Vuelve a tu panel, a <strong>Configura tus alertas (Email y WhatsApp)</strong>, y pégalo en el campo de código.</div>'
        || '<a href="https://territorio.uplevelweb.art/panel/" style="display:inline-block;background:#f18c3f;color:#0c2c57;text-decoration:none;font-size:14px;font-weight:700;padding:11px 22px;border-radius:999px;">Ir a mi panel</a>'
        || '<div style="color:#6b7c8f;font-size:12px;margin-top:14px;"><strong>El código dura 15 minutos.</strong> Si vence, pide uno nuevo desde tu panel. '
        || 'Mientras no lo confirmes no enviamos alertas por WhatsApp; tu aviso por correo sigue igual.</div>'
        || '<div style="color:#6b7c8f;font-size:12px;margin-top:8px;border-left:3px solid #f18c3f;padding-left:10px;">Una vez confirmado, el número queda fijo: solo soporte podrá cambiarlo. '
        || 'Si no fuiste tú, ignora este correo y no pasa nada. Por seguridad, este correo no incluye el código.</div>');
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

-- Confirmar codigo: igual que antes + correo "tus alertas por WhatsApp quedaron configuradas".
create or replace function public.panel_whatsapp_confirmar_codigo(p_token text, p_codigo text)
returns jsonb language plpgsql security definer
set search_path to 'public', 'net', 'extensions', 'vault' as $$
declare v_id uuid; r record; v_hash text; v_mail text; v_nombre text; v_num text; v_llave text;
        v_visible text; v_cuerpo text; v_pres text;
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
   where id = v_id
   returning email, nombre into v_mail, v_nombre;
  begin
    select decrypted_secret into v_llave from vault.decrypted_secrets where name = 'resend_api_key';
    if v_llave is not null and v_mail is not null then
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
    end if;
  exception when others then
    null;
  end;
  return jsonb_build_object('ok', true);
end $$;

-- Para el bot: entrega los datos del aviso por WhatsApp UNA sola vez, solo si se confirmo hace poco.
create or replace function public.bot_confirmacion_whatsapp(p_token text)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare v_id uuid; r record;
begin
  v_id := public._suscriptor_de_token(p_token);
  if v_id is null then return jsonb_build_object('ok', false, 'motivo', 'no autorizado'); end if;
  select whatsapp_numero, nombre, whatsapp_confirmado_en, whatsapp_confirmacion_avisada_en
    into r from public.suscriptores where id = v_id;
  if r.whatsapp_numero is null or r.whatsapp_confirmado_en is null or r.whatsapp_confirmado_en < now() - interval '15 minutes' then
    return jsonb_build_object('ok', false, 'motivo', 'sin_confirmacion_reciente'); end if;
  if r.whatsapp_confirmacion_avisada_en is not null then
    return jsonb_build_object('ok', false, 'motivo', 'ya_avisado'); end if;
  update public.suscriptores set whatsapp_confirmacion_avisada_en = now() where id = v_id;
  return jsonb_build_object('ok', true, 'numero', r.whatsapp_numero, 'nombre', r.nombre);
end $$;
revoke all on function public.bot_confirmacion_whatsapp(text) from public, anon, authenticated;
grant execute on function public.bot_confirmacion_whatsapp(text) to service_role;

-- ========== Los otros dos correos al cliente, con el mismo marco ==========
create or replace function public.pedir_acceso_panel(p_email text)
returns void language plpgsql security definer
set search_path to 'public', 'net', 'extensions', 'vault' as $$
declare
  fila   public.suscriptores%rowtype;
  token  text;
  llave  text;
  enlace text;
  cuerpo text;
  v_pres text;
begin
  select * into fila from public.suscriptores
   where email = lower(trim(p_email)) and activo = true;
  if not found then return; end if;

  token := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  update public.suscriptores
     set enlace_hash = encode(sha256(convert_to(token, 'UTF8')), 'hex'),
         enlace_expira = now() + interval '24 hours'
   where id = fila.id;

  select decrypted_secret into llave from vault.decrypted_secrets where name = 'resend_api_key';
  if llave is null then return; end if;

  enlace := 'https://territorio.uplevelweb.art/panel/?t=' || token;
  v_pres := case when fila.nombre is not null and trim(fila.nombre) <> ''
                 then 'Hola ' || split_part(trim(fila.nombre), ' ', 1) || ', soy Terri, el Asistente Inteligente de Territorio.'
                 else 'Hola, soy Terri, el Asistente Inteligente de Territorio.' end;
  cuerpo := public._correo_terri(
    'Tu enlace para entrar',
    'Enlace de un solo uso · vale 24 horas',
    '<strong>' || v_pres || '</strong> Toca el botón para entrar a tu panel'
      || case when fila.plan is not null and trim(fila.plan) <> '' then ' (plan ' || initcap(fila.plan) || ')' else '' end || '.',
    '<a href="' || enlace || '" style="display:inline-block;background:#f18c3f;color:#0c2c57;text-decoration:none;font-size:14px;font-weight:700;padding:11px 22px;border-radius:999px;">Entrar al panel</a>'
    || '<div style="color:#6b7c8f;font-size:12px;margin-top:14px;">El enlace es de un solo uso. Si no pediste este enlace, ignora este correo y no pasa nada.</div>');

  perform http_post(
    url := 'https://api.resend.com/emails',
    body := jsonb_build_object(
      'from', 'Territorio <alertas@territorio.uplevelweb.art>',
      'to', jsonb_build_array(fila.email),
      'subject', 'Tu enlace para entrar al panel de Territorio',
      'html', cuerpo),
    headers := jsonb_build_object('Authorization', 'Bearer ' || llave, 'Content-Type', 'application/json'));
end;
$$;

create or replace function public.enviar_confirmacion(p_email text)
returns bigint language plpgsql security definer
set search_path to 'public', 'net', 'extensions', 'vault' as $$
declare
  llave  text;
  fila   public.suscriptores%rowtype;
  enlace text;
  cuerpo text;
  v_pres text;
begin
  select * into fila from public.suscriptores where email = lower(trim(p_email));
  if not found then raise exception 'no existe ese correo'; end if;
  if fila.confirmado_en is not null then return null; end if;

  select decrypted_secret into llave from vault.decrypted_secrets where name = 'resend_api_key';
  if llave is null then raise exception 'No esta guardada la llave resend_api_key en el baul'; end if;

  enlace := 'https://territorio.uplevelweb.art/confirmar/?t=' || fila.token_confirmacion::text;
  v_pres := case when fila.nombre is not null and trim(fila.nombre) <> ''
                 then 'Hola ' || split_part(trim(fila.nombre), ' ', 1) || ', soy Terri, el Asistente Inteligente de Territorio.'
                 else 'Hola, soy Terri, el Asistente Inteligente de Territorio.' end;
  cuerpo := public._correo_terri(
    'Un clic y empezamos',
    'Confirma tu correo para activar tu prueba gratis',
    '<strong>' || v_pres || '</strong> Recibí tu solicitud de prueba gratis.',
    '<div style="margin-bottom:14px;">Confirma que este correo es tuyo: tu primera alerta te llega entre 10 y 20 minutos después '
    || '(depende de cuántas oportunidades tenga tu rubro). Desde el día siguiente, te llegan todos los días a la hora que elegiste '
    || '(08:00 o 15:00) las licitaciones y compras ágiles que calzan con lo que vendes.</div>'
    || '<a href="' || enlace || '" style="display:block;background:#f18c3f;color:#0c2c57;text-decoration:none;font-size:14px;font-weight:700;padding:12px 20px;border-radius:999px;text-align:center;">Confirmar y activar mi prueba</a>'
    || '<div style="color:#6b7c8f;font-size:12px;margin-top:14px;">Hasta que no hagas clic no te escribimos nada más. Si no fuiste tú, ignora este correo y no pasa nada.</div>');

  return http_post(
    url := 'https://api.resend.com/emails',
    body := jsonb_build_object(
      'from', 'Territorio <alertas@territorio.uplevelweb.art>',
      'to', jsonb_build_array(fila.email),
      'subject', 'Confirma tu correo y te mando tus oportunidades',
      'html', cuerpo),
    headers := jsonb_build_object('Authorization', 'Bearer ' || llave, 'Content-Type', 'application/json'));
end;
$$;

-- (create or replace conserva los permisos que ya tenian las funciones: no hace falta volver a otorgarlos.)
