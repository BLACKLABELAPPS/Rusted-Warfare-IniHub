## 🌌 IniHub: Rusted Warfare Modding & Mapping Cloud Database
IniHub is a specialized, secure, and self-hosted cloud database repository built exclusively for Rusted Warfare (RW) modders and mappers. Acting as the backend database for RW Studio, it allows creators to upload, organize, and store every type of file used in the Rusted Warfare ecosystem within a personal or collaborative repository.
------------------------------
## 📂 Supported Rusted Warfare Data & File Formats
IniHub is engineered to index, sort, and preserve all file assets required for Rusted Warfare development:

* .ini / .txt: Unit properties, custom logic, trigger conditions, and gameplay variables.
* .tmx / .tsx: Level layouts, map designs, and structural tilesets.
* .png: Visual sprites, particle textures, user interface assets, and terrain graphics.
* .wav / .ogg: Audio effects, unit voice lines, and background music.
* .template / .temp: Reusable code blueprints and modular asset snippets.
* .effect: Dedicated visual fx properties and custom emitter settings.

------------------------------
## ⚡ Key Advantages

* Absolute Data Ownership: The entire database lives in your own infrastructure. No third-party servers ever touch your project files, access codes, or credentials.
* Optimized Modding Storage: Organizes complex mod file trees, working drafts, and assets without corrupting file extensions or directory structures.
* Built-in Data Integrity: Prevents accidental overwrites during multi-user editing using automated file-locking and ETag verification checks.
* Exploit Protection: The system automatically blocks path-traversal exploits (..), illegal absolute paths, and secures reserved internal directories.
* Collaborative State Syncing: Seamlessly handles live history tracking, active user sessions, and secure invitation links for team projects.

------------------------------
## ⚠️ Disadvantages & Limitations

* Free Tier Storage Cap: The storage architecture limits data management to 8 GiB by default under standard usage rules.
* Self-Managed Accountability: Because the system is 100% private, you are solely responsible for managing your backups, repository visibility, and access keys.
* External Tool Dependency: This repository serves purely as a structural database; it relies entirely on RW Studio to provide the visual interface and editing tools.

------------------------------

