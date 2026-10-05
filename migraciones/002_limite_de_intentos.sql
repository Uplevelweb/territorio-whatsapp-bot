-- 002: límite de intentos. Contador simple en BD (sin servicios externos).
create table if not exists public.limite_eventos (
  clave  text not null,
  cuando timestamptz not null default now()
);
create index if not exists limite_eventos_idx on public.limite_eventos (clave, cuando desc);
alter table public.limite_eventos enable row level security;

-- true si en la ventana ya se alcanzó el máximo; si no, registra este intento.
create or replace function public._limite_excedido(p_clave text, p_max int, p_ventana interval)
returns boolean language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if random() < 0.02 then
    delete from public.limite_eventos where cuando < now() - interval '1 day';
  end if;
  select count(*) into n from public.limite_eventos
   where clave = p_clave and cuando > now() - p_ventana;
  if n >= p_max then return true; end if;
  insert into public.limite_eventos(clave) values (p_clave);
  return false;
end $$;
revoke all on function public._limite_excedido(text, int, interval) from public, anon, authenticated;

-- inscribir_alerta: máx. 5 por correo por hora y 300 en total por hora.
create or replace function public.inscribir_alerta(p_email text, p_nombre text DEFAULT NULL::text, p_rut text DEFAULT NULL::text, p_palabras text[] DEFAULT '{}'::text[], p_regiones text[] DEFAULT '{}'::text[], p_hora smallint DEFAULT 8, p_licitaciones boolean DEFAULT true, p_agiles boolean DEFAULT true, p_telefono_contacto text DEFAULT NULL::text)
 returns boolean language plpgsql security definer set search_path to 'public' as $function$
declare
  v_id uuid;
  v_ya_existia boolean;
begin
  if p_email is null or position('@' in p_email) = 0 then
    raise exception 'correo invalido';
  end if;
  if public._limite_excedido('inscribir:' || lower(trim(p_email)), 5, interval '1 hour')
     or public._limite_excedido('inscribir:global', 300, interval '1 hour') then
    raise exception 'demasiados intentos, vuelve a probar en un rato';
  end if;
  if p_hora not in (8, 15) then
    p_hora := 8;
  end if;
  select exists(select 1 from suscriptores where email = lower(trim(p_email))) into v_ya_existia;
  insert into suscriptores (email, nombre, rut_empresa, origen_consentimiento, activo, telefono_contacto)
  values (lower(trim(p_email)), nullif(trim(p_nombre), ''), nullif(trim(p_rut), ''), 'formulario_web', true, nullif(trim(p_telefono_contacto), ''))
  on conflict (email) do update set
    activo = true,
    nombre = coalesce(nullif(trim(p_nombre), ''), suscriptores.nombre),
    telefono_contacto = coalesce(nullif(trim(p_telefono_contacto), ''), suscriptores.telefono_contacto)
  returning id into v_id;
  delete from filtros where suscriptor_id = v_id;
  insert into filtros (suscriptor_id, rut_proveedor, palabras_clave, regiones, hora_envio, incluye_licitaciones, incluye_compras_agiles, frecuencia)
  values (v_id, nullif(trim(p_rut), ''), p_palabras, p_regiones, p_hora, p_licitaciones, p_agiles, 'diaria');

  if not v_ya_existia then
    begin
      perform public.avisar_serling_nuevo_suscriptor(v_id);
    exception when others then
      raise warning 'No se pudo avisar del nuevo suscriptor: %', sqlerrm;
    end;
  end if;

  return v_ya_existia;
end;
$function$;

-- panel_entrar_admin: tras 10 claves erróneas en 15 minutos, no se evalúa ninguna más
-- (ni la correcta) hasta que pase la ventana.
create or replace function public.panel_entrar_admin(p_clave text)
 returns table(email text, nombre text, plan text, rol text, activo boolean, sesion text)
 language plpgsql security definer set search_path to 'public' as $function$
declare
  v_id     uuid;
  v_sesion text;
begin
  if (select count(*) from public.limite_eventos
       where clave = 'admin:fallo' and cuando > now() - interval '15 minutes') >= 10 then
    return;
  end if;

  select s.id into v_id from public.suscriptores s
   where s.rol = 'superadmin'
     and s.clave_hash is not null
     and s.clave_hash = encode(sha256(convert_to(coalesce(p_clave, ''), 'UTF8')), 'hex');

  if v_id is null then
    insert into public.limite_eventos(clave) values ('admin:fallo');
    return;
  end if;

  v_sesion := replace(gen_random_uuid()::text, '-', '')
              || replace(gen_random_uuid()::text, '-', '');

  update public.suscriptores
     set sesion_hash = encode(sha256(convert_to(v_sesion, 'UTF8')), 'hex'),
         sesion_expira = now() + interval '30 days'
   where id = v_id;

  return query
    select s.email, s.nombre, s.plan, s.rol, s.activo, v_sesion
      from public.suscriptores s
     where s.id = v_id;
end;
$function$;
