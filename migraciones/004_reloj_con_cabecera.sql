-- 004: el reloj manda la clave por cabecera (x-tarea-clave) y no en la URL.
-- Reutiliza la clave que ya está en el comando actual (no hay que escribirla).
-- APLICAR ANTES de desplegar el bot nuevo (el bot viejo ya acepta la cabecera).
do $$
declare v_cmd text; v_clave text;
begin
  select command into v_cmd from cron.job where jobname = 'sincronizar-al-dia';
  v_clave := substring(v_cmd from 'clave=([A-Za-z0-9]+)');
  if v_clave is not null then
    perform cron.unschedule('sincronizar-al-dia');
    perform cron.schedule('sincronizar-al-dia', '0 13 * * *',
      format($c$select net.http_get(url := 'https://territorio-whatsapp-bot.onrender.com/tareas/sincronizar-flow', headers := jsonb_build_object('x-tarea-clave', %L))$c$, v_clave));
  end if;
end $$;
