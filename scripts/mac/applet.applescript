-- 縦型動画メーカー(Mac アプリ版)
-- 起動すると同梱のサーバーを立ち上げ、いつものブラウザで画面を開く。
-- Dock のアイコンをクリックすると画面を開き直し、終了するとサーバーも止める。
property serverPID : ""

on run
	set launcher to POSIX path of (path to resource "launcher.sh")
	try
		set serverPID to do shell script "/bin/bash " & quoted form of launcher & " start"
	on error errMsg
		display dialog "起動できませんでした。" & return & return & errMsg & return & return & "詳しい記録: ~/TateDougaMaker/app.log" buttons {"OK"} default button "OK" with icon stop
		quit
	end try
end run

on reopen
	do shell script "open http://127.0.0.1:5178/"
end reopen

on idle
	return 300
end idle

on quit
	if serverPID is not "" and serverPID is not "running" then
		do shell script "kill " & serverPID & " >/dev/null 2>&1 || true"
	end if
	continue quit
end quit
