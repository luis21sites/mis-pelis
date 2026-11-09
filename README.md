# Mis Pelis — cómo ponerla en marcha

App privada para apuntar las películas y series que ves. Tus datos se guardan en tu propio dispositivo. Si activas la copia en la nube, se cifran con tu contraseña antes de salir del móvil.

## 1. Consigue las claves (gratis)
- **TMDb**: crea una cuenta en themoviedb.org → Ajustes → API → solicita una clave (uso personal). Copia la "Clave de la API".
- **OMDb**: en omdbapi.com/apikey.aspx elige FREE, pon tu correo y **activa la clave con el enlace que te llega por email**.
- **GitHub** (para la copia cifrada): github.com → Settings → Developer settings → Personal access tokens → **Tokens (classic)** → Generate new token. Marca **solo** la casilla `gist`. Pon la caducidad que prefieras (si caduca, creas otro y lo pegas en Ajustes).

## 2. Publica la app en GitHub Pages (gratis, desde el ordenador)
1. En GitHub pulsa **New repository** → nombre `mis-pelis` → **Public** → Create.
2. Pulsa **uploading an existing file** y arrastra **todo el contenido** de esta carpeta, incluida la carpeta `icons`. Luego pulsa **Commit changes**.
3. Ve a **Settings → Pages** → en "Branch" elige `main` y la carpeta `/ (root)` → Save.
4. En un minuto o dos tendrás la app en `https://TU-USUARIO.github.io/mis-pelis/`.

En el repositorio solo queda el código. Ahí no hay ninguna clave ni ningún dato tuyo.

## 3. Instálala
- **iPhone**: abre la dirección en **Safari** → botón Compartir → **Añadir a pantalla de inicio**. Ábrela siempre desde ese icono: así iOS no borra sus datos.
- **Ordenador**: abre la misma dirección en Chrome o Edge (puedes instalarla con el icono ⊕ de la barra de direcciones).

## 4. Configúrala (en cada dispositivo)
En **Ajustes**:
1. Pega las claves de TMDb y OMDb → Guardar.
2. Pega el token de GitHub y elige una **contraseña de cifrado** → Activar.
   Usa **la misma contraseña** en el iPhone y en el ordenador. **Apúntala bien**: si la pierdes, la copia no se puede descifrar.

El punto de arriba a la derecha indica el estado de la copia: verde = al día, amarillo = sincronizando, rojo = error. Si lo pulsas, sincroniza en ese momento.

## Privacidad, en resumen
- Lo que has visto, tus notas y tus comentarios: en tu dispositivo y, cifrados, en un Gist secreto de tu GitHub.
- TMDb y OMDb solo reciben lo que buscas (el título o el código de la película), no tu lista.
- Los pósters se descargan de TMDb y luego se guardan en el móvil.
