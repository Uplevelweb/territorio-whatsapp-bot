-- 018 · El aviso de "soporte humano" llega TAMBIEN a contacto@uplevelweb.art (pedido de Serling, 11-10-2026).
-- Se aplica sobre la funcion bot_derivar que ya existe (su definicion vive solo en la base).
do $$ declare d text; begin
  d := pg_get_functiondef('public.bot_derivar(text,text,text,text)'::regprocedure);
  if position('contacto@uplevelweb.art' in d) = 0 then
    d := replace(d, $a$jsonb_build_array('webuplevel@gmail.com')$a$, $a$jsonb_build_array('webuplevel@gmail.com','contacto@uplevelweb.art')$a$);
    execute d;
  end if;
end $$;
