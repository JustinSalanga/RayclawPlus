Add new features.
1. System tray notification popup
- When the app loses focus, if the task is completed, send notification.
- When the scheduler runs, send notification.
- If the user clicks notification balloon, show the chat.

2. Multiple types of attachment.
Now, only images are available to attach.
The app must support most of media files to attach.
- images: already done
- documents: pdf, doc. docx, xls, xlsx, ppt, pptx, txt, md, log, ini, conf, and all code language files (js, py, rs, etc.).
- archieves: rar, zip, 7z
create zip/unzip tool if it does not exist.

3. Cron job
Now, the app has scheduler, but it doesn't work.
setting up scheduler works, but it never run. it must be run at correct time.
Check this out.
And the scheduled tasks are managed per chat.
but all scheduled tasks must be managed unitedly.
if the scheduled task runs, show system notification and do not close it until the user clicks.
if the user clicks the notification, show the chat.

4. Minimize to system tray.
- When the user clicks close button on the window, minimize app to system tray.
- System tray icon has a context menu: Open, Setting, Quit.