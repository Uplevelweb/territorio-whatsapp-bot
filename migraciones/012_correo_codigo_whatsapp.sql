-- 012 · Terri avisa POR CORREO cuando alguien inicia la configuracion de su WhatsApp,
-- con el mismo codigo, para que el proceso sea coherente y de confianza.
-- Se manda desde aqui mismo (igual que enviar_confirmacion: Resend + llave en el baul).
-- Si el correo falla, el codigo igual se entrega en el panel (no se rompe nada).

create or replace function public.panel_whatsapp_pedir_codigo(p_token text, p_numero text default null)
returns jsonb language plpgsql security definer
set search_path to 'public', 'net', 'extensions', 'vault' as $$
declare v_id uuid; v_cod text := 'TERRI-'; v_alf text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; i int; v_num text;
        v_mail text; v_nombre text; v_llave text; v_cuerpo text; v_enlace text; v_visible text;
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
   where id = v_id
   returning email, nombre into v_mail, v_nombre;

  -- Correo de Terri (nunca debe romper la entrega del codigo en el panel).
  begin
    select decrypted_secret into v_llave from vault.decrypted_secrets where name = 'resend_api_key';
    if v_llave is not null and v_mail is not null then
      v_enlace := 'https://wa.me/56967329214?text=' || v_cod;
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
     <div style="padding-top:14px;">Para confirmarlo, <strong>copia y pega este c&oacute;digo</strong> en un mensaje a nuestro WhatsApp <strong>+56 9 6732 9214</strong>, enviado desde ese mismo celular:</div>
     <div style="margin-top:14px;padding:16px;background:#f4f6fa;border-radius:10px;text-align:center;font-size:26px;letter-spacing:3px;font-weight:700;color:#0c2c57;">%s</div>
     <div style="padding-top:20px;"><a href="%s" style="display:block;box-sizing:border-box;background:#f18c3f;color:#0c2c57;text-decoration:none;font-size:16px;font-weight:700;padding:14px 20px;border-radius:999px;text-align:center;">Abrir WhatsApp con el c&oacute;digo</a></div>
     <div style="padding-top:20px;font-size:13.5px;color:#6b7c8f;">El c&oacute;digo vale 30 minutos. Si no fuiste t&uacute;, ignora este correo: sin tu mensaje desde ese celular no se vincula nada.</div>
   </td></tr>
  </table>
 </td></tr>
</table>$html$,
        case when coalesce(trim(v_nombre),'') = '' then '' else ' ' || split_part(trim(v_nombre), ' ', 1) end,
        v_visible, v_cod, v_enlace);
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
    null;  -- el codigo ya esta en el panel; el correo es un respaldo de confianza
  end;

  return jsonb_build_object('ok', true, 'codigo', v_cod, 'expira_min', 30, 'numero', v_num);
end $$;
grant execute on function public.panel_whatsapp_pedir_codigo(text, text) to anon, authenticated;
