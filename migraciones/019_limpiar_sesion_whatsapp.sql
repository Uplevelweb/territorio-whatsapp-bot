-- 019 · Sesion del bot de WhatsApp limpia sola cuando el suscriptor o su numero desaparecen
-- (25-10-2026, pedido de Serling). Aplicada el 26-10-2026 ("PASAR A PRODUCCION").
--
-- Problema: al eliminar a un suscriptor o cambiarle/borrarle el numero, la fila de
-- `bot_conversaciones` de ese telefono quedaba intacta, y el bot lo seguia tratando
-- como el cliente de antes (menu de cliente, "Ver detalle" de alertas viejas, etc.).
--
-- 1) Trigger: al borrar un suscriptor, o cambiar/borrar su numero, se borra la conversacion
--    guardada de los numeros que dejaron de ser suyos.
-- 2) bot_numero_registrado(): el bot la consulta antes de seguir una sesion de cliente;
--    sirve ademas para limpiar la memoria del servidor, que el trigger no alcanza.
-- Los numeros se comparan por sus ultimos 9 digitos: en la base hay formatos distintos
-- (+56 9..., 569..., 9...), y el bot recibe 569XXXXXXXX.

create or replace function public.solo_digitos_9(p text) returns text
language sql immutable as $$
  select nullif(right(regexp_replace(coalesce(p, ''), '\D', '', 'g'), 9), '')
$$;

create or replace function public.bot_numero_registrado(p_telefono text) returns boolean
language sql security definer set search_path to 'public' stable as $$
  select exists (
    select 1 from suscriptores s
     where solo_digitos_9(p_telefono) is not null
       and solo_digitos_9(p_telefono) in (
             solo_digitos_9(s.whatsapp_numero),
             solo_digitos_9(s.whatsapp_numero_pendiente),
             solo_digitos_9(s.telefono_contacto))
  )
$$;
revoke all on function public.bot_numero_registrado(text) from public, anon, authenticated;
grant execute on function public.bot_numero_registrado(text) to service_role;

create or replace function public.bot_limpiar_conversacion_huerfana() returns trigger
language plpgsql security definer set search_path to 'public' as $$
declare v_viejos text[]; v_nuevos text[];
begin
  v_viejos := array_remove(array[solo_digitos_9(old.whatsapp_numero),
                                 solo_digitos_9(old.whatsapp_numero_pendiente),
                                 solo_digitos_9(old.telefono_contacto)], null);
  if tg_op = 'UPDATE' then
    v_nuevos := array_remove(array[solo_digitos_9(new.whatsapp_numero),
                                   solo_digitos_9(new.whatsapp_numero_pendiente),
                                   solo_digitos_9(new.telefono_contacto)], null);
    -- solo los numeros que dejaron de pertenecerle
    select coalesce(array_agg(x), '{}') into v_viejos
      from unnest(v_viejos) x where not (x = any(v_nuevos));
  end if;
  if coalesce(array_length(v_viejos, 1), 0) > 0 then
    -- No se borra la conversacion si OTRO suscriptor sigue teniendo ese numero.
    delete from bot_conversaciones c
     where solo_digitos_9(c.telefono) = any(v_viejos)
       and not exists (
         select 1 from suscriptores s
          where s.id <> old.id
            and solo_digitos_9(c.telefono) in (solo_digitos_9(s.whatsapp_numero),
                                               solo_digitos_9(s.whatsapp_numero_pendiente),
                                               solo_digitos_9(s.telefono_contacto)));
  end if;
  return coalesce(new, old);
end $$;

drop trigger if exists limpiar_conversacion_huerfana on public.suscriptores;
create trigger limpiar_conversacion_huerfana
  after delete or update of whatsapp_numero, whatsapp_numero_pendiente, telefono_contacto
  on public.suscriptores
  for each row execute function public.bot_limpiar_conversacion_huerfana();
