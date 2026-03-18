@echo off
echo Updating Roll Together + Chatroom...
git pull origin master
echo Installing dependencies...
npm install
echo Building extension...
npm run build
echo.
echo Done! Now go to chrome://extensions and click the reload button on Roll Together + Chatroom.
pause