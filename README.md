# Google Slides Capturer Web ZIP

Versión web de la app para capturar presentaciones publicadas/embed de Google Slides y descargar un ZIP con todo.

## Qué hace

- Preview antes de exportar.
- Exporta imágenes PNG.
- Opcionalmente genera también PDF.
- Mete todo dentro de un ZIP.
- Te deja descargar el ZIP desde navegador.
- Ideal para deploy en Railway / Render / VPS.
- Captura limpia sin bordes/controles de Google Slides.
- Presets de resolución:
  - HD 1280x720
  - Full HD 1920x1080
  - 2K 2560x1440
  - 4K 3840x2160
- Barra de progreso real.
- Reintentos automáticos por slide.
- Validación de capturas vacías o mal cargadas.
- Cancelar proceso en curso.
- Modo rango conservando prefijo:
  - `slide=id.p57` -> `slide=id.p1`, `slide=id.p2`, `slide=id.p3`...

## Cómo funciona en esta versión web

En vez de guardar una carpeta local para el usuario:

1. la app genera los PNG;
2. si querés, genera también el PDF;
3. arma un ZIP con todo;
4. te da un link de descarga.

Los archivos quedan disponibles temporalmente en el servidor y luego se borran solos.

## Instalación local

Necesitás Node.js instalado.

```bash
npm install
npm start
```

Abrí:

```text
http://localhost:3030
```

## Deploy recomendado

Esta app usa Playwright + Chromium, así que conviene deployarla con Docker.

### Railway / Render / VPS

Usá el `Dockerfile` incluido.

## Modo rango

Si activás modo rango y elegís de 1 a 60, la app toma el valor actual de `slide` y reemplaza solamente el número final.

Ejemplo original:

```text
...?slide=id.p57
```

Genera:

```text
...?slide=id.p1
...?slide=id.p2
...?slide=id.p3
...
...?slide=id.p60
```

## Captura limpia

La captura limpia recorta el área central de la diapositiva y elimina controles/barra inferior/bordes del visor.
Por defecto usa formato 16:9. Si tu presentación es vieja o cuadrada, probá 4:3.

## Validación de captura vacía

La app analiza el PNG generado. Si detecta que la imagen es casi toda negra, blanca o sin variación visual, la marca como sospechosa y reintenta.

Si falla aunque la slide esté bien, subí el delay de carga a 2500 o 3000 ms.

## Expiración

Los ZIP y archivos temporales se eliminan automáticamente después de aproximadamente 60 minutos.
