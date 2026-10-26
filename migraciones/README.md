# Migraciones de la base de datos (Supabase `nvjmgpmvhrodirykoirq`)

Numeradas, una vez aplicada una NO se edita: se crea otra con el número siguiente.
Se aplican en orden en el SQL Editor de Supabase. Cada archivo es idempotente
(se puede correr dos veces sin romper nada).

| N° | Archivo | Qué hace | Estado |
|----|---------|----------|--------|
| 001 | 001_pagos_pendientes.sql | Tabla + funciones para guardar el registro de tarjeta pendiente (antes en memoria) | pendiente |
| 002 | 002_limite_de_intentos.sql | Límite de intentos en `inscribir_alerta` y `panel_entrar_admin` | pendiente |
| 003 | 003_vigilante_alertas.sql | Aviso por correo si hoy no salió ninguna alerta (dead-man's switch) | pendiente |
| 004 | 004_reloj_con_cabecera.sql | El reloj `sincronizar-al-dia` manda la clave por cabecera, no por la URL | pendiente |
| 019 | 019_limpiar_sesion_whatsapp.sql | Borra la conversación del bot cuando un suscriptor o su número desaparece; función bot_numero_registrado | aplicada 26-10-2026 |
| 020 | 020_cancelar_flow_al_borrar.sql | Al borrar un suscriptor con Flow, anota su cancelación y el bot la ejecuta cada 15 min | aplicada 26-10-2026 |
