# Чужой код в этом репозитории

- `kit/` – набор для приложений iDrive 7 из [idrive7-apps](https://github.com/cauliflowermossgrape/idrive7-apps), лицензия MIT (`kit/LICENSE`). Взята часть, нужная одному приложению. Две правки: версия пакета без суффикса перевода (`kit/tools/localize.py`) и русские строки приложения, которые не переводятся по словам (`kit/runtime/i18n.js`).
- `service/src/cluster_render_client.js` – клиент службы cluster-render из [idrive-apps](https://github.com/robertnisipeanu/idrive-apps), (C) 2026 Robert Nisipeanu, лицензия MPL-2.0. Файл не менялся. Он же целиком входит в собранный `service/prebuilt/hudradar`.

HUD Speed – приложение и товарный знак его разработчиков. Этот проект с ними не связан, не содержит их кода, картинок и базы камер.
