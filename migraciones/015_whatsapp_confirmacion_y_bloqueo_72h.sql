-- 015 · WhatsApp: aviso de "numero configurado" (correo + WhatsApp) y bloqueo de cambio por 72 horas.
-- Pedido de Serling (09-10-2026): al confirmar el numero hay que avisar por WhatsApp Y por correo que
-- las alertas de WhatsApp quedaron configuradas, y no dejar cambiar el numero durante 72 horas
-- (evita el mal uso del WhatsApp: abrir y cambiar numeros a cada rato).
-- El bloqueo es solo para el cliente: el superadmin sigue pudiendo cambiarlo (panel_admin_whatsapp).

alter table public.suscriptores add column if not exists whatsapp_confirmacion_avisada_en timestamptz;

-- Hasta cuando esta bloqueado el cambio (null = libre).
create or replace function public._wa_bloqueo_hasta(p_id uuid)
returns timestamptz language sql stable security definer set search_path to 'public' as $$
  select case when whatsapp_numero is not null and whatsapp_confirmado_en is not null
               and whatsapp_confirmado_en + interval '72 hours' > now()
              then whatsapp_confirmado_en + interval '72 hours' end
    from public.suscriptores where id = p_id;
$$;
revoke all on function public._wa_bloqueo_hasta(uuid) from public, anon, authenticated;

create or replace function public._wa_texto_bloqueo(p_hasta timestamptz)
returns text language sql immutable as $$
  select 'Por seguridad, tu número de WhatsApp no se puede cambiar durante las 72 horas siguientes a configurarlo. Podrás cambiarlo desde el '
         || to_char(p_hasta at time zone 'America/Santiago', 'DD-MM-YYYY') || ' a las '
         || to_char(p_hasta at time zone 'America/Santiago', 'HH24:MI') || '.';
$$;

-- Estado para pintar la tarjeta (agrega: bloqueado_hasta y su texto).
create or replace function public.panel_whatsapp_estado(p_token text)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare v_id uuid; r record; v_b timestamptz;
begin
  v_id := public._suscriptor_de_token(p_token);
  if v_id is null then return jsonb_build_object('ok', false, 'motivo', 'no autorizado'); end if;
  select whatsapp_numero, whatsapp_confirmado_en, whatsapp_codigo_hash, whatsapp_codigo_expira,
         whatsapp_numero_pendiente, telefono_contacto
    into r from public.suscriptores where id = v_id;
  v_b := public._wa_bloqueo_hasta(v_id);
  return jsonb_build_object('ok', true,
    'confirmado', r.whatsapp_confirmado_en is not null and r.whatsapp_numero is not null,
    'numero', case when r.whatsapp_numero is null then null
                   else '+' || left(r.whatsapp_numero, 3) || ' ••• ' || right(r.whatsapp_numero, 4) end,
    'pendiente', r.whatsapp_codigo_hash is not null and r.whatsapp_codigo_expira > now(),
    'expira', r.whatsapp_codigo_expira,
    'numero_escrito', coalesce(r.whatsapp_numero_pendiente, r.telefono_contacto),
    'bloqueado_hasta', v_b,
    'bloqueo_texto', case when v_b is null then null else public._wa_texto_bloqueo(v_b) end);
end $$;

-- Quitar / cambiar: bloqueado durante 72 horas despues de confirmar.
create or replace function public.panel_whatsapp_quitar(p_token text)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare v_id uuid; v_b timestamptz;
begin
  v_id := public._suscriptor_de_token(p_token);
  if v_id is null then return jsonb_build_object('ok', false, 'motivo', 'no autorizado'); end if;
  v_b := public._wa_bloqueo_hasta(v_id);
  if v_b is not null then
    return jsonb_build_object('ok', false, 'motivo', public._wa_texto_bloqueo(v_b), 'bloqueado_hasta', v_b); end if;
  update public.suscriptores
     set whatsapp_numero = null, whatsapp_confirmado_en = null, whatsapp_numero_pendiente = null,
         whatsapp_codigo_hash = null, whatsapp_codigo_expira = null, whatsapp_confirmacion_avisada_en = null
   where id = v_id;
  return jsonb_build_object('ok', true);
end $$;

-- Pedir codigo (primer numero o cambio): si ya hay uno confirmado hace menos de 72 h, se rechaza.
-- (Se reemplaza la funcion de 014 agregando SOLO el chequeo del bloqueo, justo despues de validar la sesion.)
do $mig$
declare v_def text;
begin
  select pg_get_functiondef('public.panel_whatsapp_pedir_codigo(text,text)'::regprocedure) into v_def;
  if v_def not like '%_wa_bloqueo_hasta%' then
    v_def := replace(v_def,
      E'  v_num := public._normalizar_movil_cl(p_numero);',
      E'  if public._wa_bloqueo_hasta(v_id) is not null then\n    return jsonb_build_object(''ok'', false, ''motivo'', public._wa_texto_bloqueo(public._wa_bloqueo_hasta(v_id)));\n  end if;\n  v_num := public._normalizar_movil_cl(p_numero);');
    if v_def not like '%_wa_bloqueo_hasta%' then raise exception 'no se pudo insertar el bloqueo en panel_whatsapp_pedir_codigo'; end if;
    execute v_def;
  end if;
end $mig$;

-- Confirmar codigo: igual que antes + correo "tu WhatsApp quedo configurado".
create or replace function public.panel_whatsapp_confirmar_codigo(p_token text, p_codigo text)
returns jsonb language plpgsql security definer
set search_path to 'public', 'net', 'extensions', 'vault' as $$
declare v_id uuid; r record; v_hash text; v_mail text; v_nombre text; v_num text; v_llave text;
        v_visible text; v_hasta timestamptz; v_cuerpo text;
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
  v_num := r.whatsapp_numero_pendiente;
  update public.suscriptores
     set whatsapp_numero = v_num, whatsapp_confirmado_en = now(),
         whatsapp_numero_pendiente = null, whatsapp_codigo_hash = null, whatsapp_codigo_expira = null,
         whatsapp_confirmacion_avisada_en = null
   where id = v_id
   returning email, nombre, whatsapp_confirmado_en + interval '72 hours' into v_mail, v_nombre, v_hasta;

  -- Correo de confirmacion (nunca debe romper la confirmacion).
  begin
    select decrypted_secret into v_llave from vault.decrypted_secrets where name = 'resend_api_key';
    if v_llave is not null and v_mail is not null then
      v_visible := '+' || left(v_num, 2) || ' ' || substr(v_num, 3, 1) || ' ' || substr(v_num, 4, 4) || ' ' || substr(v_num, 8);
      v_cuerpo := format($html$
<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light"></head>
<body bgcolor="#f4f6fa" style="margin:0;padding:0;background:#f4f6fa;">
<table width="100%%" cellpadding="0" cellspacing="0" border="0" bgcolor="#f4f6fa" style="background:#f4f6fa;padding:26px 10px;">
 <tr><td align="center">
  <table width="100%%" cellpadding="0" cellspacing="0" border="0" bgcolor="#ffffff" style="max-width:600px;background:#ffffff;border-radius:12px;overflow:hidden;">
   <tr><td bgcolor="#ffffff" style="background:#ffffff;padding:18px 24px 12px;">
     <table cellpadding="0" cellspacing="0" border="0"><tr>
       <td style="padding-right:10px;"><img src="https://territorio.uplevelweb.art/img/logo.png" width="34" height="34" alt="Uplevel" style="display:block;border-radius:12px;padding:7px;background:#ffffff;box-sizing:border-box;"></td>
       <td style="color:#0c2c57;font-size:16.5px;font-weight:700;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;">Territorio</td>
     </tr></table>
   </td></tr>
   <tr><td height="3" bgcolor="#f18c3f" style="height:3px;background:#f18c3f;font-size:0;line-height:0;">&nbsp;</td></tr>
   <tr><td bgcolor="#ffffff" style="background:#ffffff;padding:22px 24px 26px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#1a2b3d;font-size:16px;line-height:1.55;">
     <div style="font-size:20px;font-weight:700;color:#0c2c57;">&#10003; Tus alertas por WhatsApp quedaron configuradas</div>
     <div style="padding-top:10px;">Hola%s. Confirmamos el n&uacute;mero <b>%s</b>: <b>desde ahora recibir&aacute;s en ese WhatsApp un aviso diario con cu&aacute;ntas oportunidades hay para ti</b>. El detalle completo sigue llegando a tu correo.</div>
     <div style="padding-top:14px;background:#f1f8f3;border-left:4px solid #1f9d55;margin-top:16px;padding:12px 14px;font-size:15px;">
       Por seguridad, este n&uacute;mero <b>no se podr&aacute; cambiar durante 72 horas</b>. Podr&aacute;s cambiarlo desde el <b>%s</b>.
     </div>
     <div style="padding-top:16px;font-size:13.5px;color:#6b7c8f;">Si no fuiste t&uacute;, escr&iacute;benos de inmediato por WhatsApp al <a href="https://wa.me/56967329214?text=No%%20fui%%20yo%%20el%%20que%%20configur%%C3%%B3%%20mi%%20WhatsApp" style="color:#0c2c57;font-weight:600;">+56 9 6732 9214</a>. <b>No respondas este correo</b>, nadie lo lee.</div>
   </td></tr>
  </table>
  <div style="max-width:600px;text-align:center;color:#8d9aa8;font-size:12.5px;padding-top:14px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;">Uplevel &middot; Territorio</div>
 </td></tr>
</table></body></html>$html$,
        case when coalesce(trim(v_nombre),'') = '' then '' else ', ' || split_part(trim(v_nombre), ' ', 1) end,
        v_visible,
        to_char(v_hasta at time zone 'America/Santiago', 'DD-MM-YYYY') || ' a las ' || to_char(v_hasta at time zone 'America/Santiago', 'HH24:MI'));
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
  return jsonb_build_object('ok', true, 'bloqueado_hasta', v_hasta);
end $$;

-- Para el bot: entrega los datos del aviso por WhatsApp UNA sola vez, solo si se confirmo hace poco.
create or replace function public.bot_confirmacion_whatsapp(p_token text)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare v_id uuid; r record;
begin
  v_id := public._suscriptor_de_token(p_token);
  if v_id is null then return jsonb_build_object('ok', false, 'motivo', 'no autorizado'); end if;
  select whatsapp_numero, nombre, whatsapp_confirmado_en, whatsapp_confirmacion_avisada_en,
         whatsapp_confirmado_en + interval '72 hours' as hasta
    into r from public.suscriptores where id = v_id;
  if r.whatsapp_numero is null or r.whatsapp_confirmado_en is null or r.whatsapp_confirmado_en < now() - interval '15 minutes' then
    return jsonb_build_object('ok', false, 'motivo', 'sin_confirmacion_reciente'); end if;
  if r.whatsapp_confirmacion_avisada_en is not null then
    return jsonb_build_object('ok', false, 'motivo', 'ya_avisado'); end if;
  update public.suscriptores set whatsapp_confirmacion_avisada_en = now() where id = v_id;
  return jsonb_build_object('ok', true, 'numero', r.whatsapp_numero, 'nombre', r.nombre,
    'hasta', to_char(r.hasta at time zone 'America/Santiago', 'DD-MM-YYYY') || ' ' || to_char(r.hasta at time zone 'America/Santiago', 'HH24:MI'));
end $$;
revoke all on function public.bot_confirmacion_whatsapp(text) from public, anon, authenticated;
grant execute on function public.bot_confirmacion_whatsapp(text) to service_role;

grant execute on function public.panel_whatsapp_estado(text), public.panel_whatsapp_quitar(text),
  public.panel_whatsapp_confirmar_codigo(text,text), public.panel_whatsapp_pedir_codigo(text,text) to anon, authenticated;
