-- 003: dead-man's switch. Si en un turno no salió NINGÚN envío, avisa por correo
-- (misma vía que el aviso de nuevo suscriptor: Resend con la clave ya guardada en Vault).
create or replace function public.vigilar_alertas(p_desde_utc time)
returns void language plpgsql security definer
set search_path to 'public', 'net', 'extensions', 'vault' as $$
declare
  llave text; n int; activos int; desde timestamptz;
begin
  desde := (current_date + p_desde_utc) at time zone 'UTC';
  select count(*) into n from public.envios where enviado_en >= desde;
  select count(*) into activos from public.suscriptores where activo;
  if n > 0 or activos = 0 then return; end if;

  select decrypted_secret into llave from vault.decrypted_secrets where name = 'resend_api_key';
  if llave is null then return; end if;

  perform http_post(
    url := 'https://api.resend.com/emails',
    body := jsonb_build_object(
      'from', 'Territorio <alertas@uplevelweb.art>',
      'to', jsonb_build_array('webuplevel@gmail.com'),
      'subject', 'Territorio: hoy no salió ninguna alerta',
      'html', '<p>Desde las ' || to_char(desde at time zone 'America/Santiago','HH24:MI') ||
              ' no se registró ningún envío y hay ' || activos || ' suscriptores activos. ' ||
              'Puede ser un día sin coincidencias o una falla del reloj / GitHub Actions: conviene revisar.</p>'),
    headers := jsonb_build_object('Authorization', 'Bearer ' || llave, 'Content-Type', 'application/json'));
end $$;
revoke all on function public.vigilar_alertas(time) from public, anon, authenticated;

-- Lunes a sábado: 9:30 y 16:30 hora Chile verano (12:30 y 19:30 UTC).
select cron.unschedule('vigilar-turno-8')  where exists (select 1 from cron.job where jobname='vigilar-turno-8');
select cron.unschedule('vigilar-turno-15') where exists (select 1 from cron.job where jobname='vigilar-turno-15');
select cron.schedule('vigilar-turno-8',  '30 12 * * 1-6', $$select public.vigilar_alertas('11:00')$$);
select cron.schedule('vigilar-turno-15', '30 19 * * 1-6', $$select public.vigilar_alertas('18:00')$$);
