#!/bin/bash
# A menu driven shell script sample template 
## ----------------------------------
# Step #1: Define variables
# ----------------------------------
 
# ----------------------------------
# Step #2: User defined function
# ----------------------------------
pause(){
  read -p "Press [Enter] key to continue..." fackEnterKey
}


one(){
	echo "Installing QSLP and Prerequisites"
	sudo apt-get -y install curl dirmngr apt-transport-https lsb-release ca-certificates
	sudo apt-get -y install mongodb
	sudo apt-get -y install redis-server
	cp qslp.ini.example qslp.ini
	sudo ufw allow 8001
	yarn install
        pause
}
 
# do something in two()
two(){
	echo "Updating QSLP"
	pm2 stop qslpParser.js
	pm2 stop qslpApi.js
	sleep 1
	git pull
	sleep 1
	sudo ufw allow 8001
	sleep 1
	yarn install
	sleep 1
	pm2 start qslpParser.js
	sleep 1
	pm2 start qslpApi.js
	sleep 1
	echo "QSLP has been succesfully updated."
        pause
}

three(){
        echo "Starting QSLP"
        pm2 start qslpParser.js
	sleep 1
	pm2 start qslpApi.js
        echo "QSLP has been succesfully started."
        pause
} 

four(){
        echo "Stopping QSLP"
        pm2 stop qslpParser.js
        pm2 stop qslpApi.js
        echo "QSLP has been succesfully stopped."
	sleep 1
	echo "Starting QSLP"
        pm2 start qslpParser.js
	sleep 1
	pm2 start qslpApi.js
        echo "QSLP has been succesfully started."
        pause
} 

five(){
        echo "Stopping QSLP"
        pm2 stop qslpParser.js
        sleep 1
        pm2 stop qslpApi.js
        echo "QSLP has been succesfully stopped."
        pause
} 

six(){
        echo "Starting PM2 Monitor"
        pm2 monit
        pause
} 

seven(){
        echo "PM2 Status"
        pm2 status   
        pause
} 

eight(){
	echo "Stopping all QSLP Processes"
	pm2 stop qslpParser.js
        pm2 stop qslpApi.js
	echo "Pulling updates"
	sleep 1
	git pull
	echo "Installing Prerequisites"
	sleep 1
	sudo apt-get -y install curl dirmngr apt-transport-https lsb-release ca-certificates
	sudo apt-get -y install mongodb
	sudo apt-get -y install redis-server
	echo "Resetting Config"
	sleep 1
	cp qslp.ini.example qslp.ini
	echo "Adding Port 8001 to UFW"
	sleep 1
	sudo ufw allow 8001
	echo "Installing QSLP"
	sleep 1
	yarn install
	echo "Starting QSLP"
	sleep 1
        pm2 start qslpParser.js
	sleep 1
	pm2 start qslpApi.js
        echo "QSLP has been succesfully installed and launched."
        pause
} 
# function to display menus
show_menus() {
	clear
	echo "~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~"
	echo "      Qredit Side Ledger Protocol      "
	echo "~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~"
	echo "      QSLP Sidechain Manager v1.1      "
        echo "~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~"
	echo "           M A I N - M E N U           "
	echo "~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~"
	echo "1. Install QSLP"
	echo "2. Update QSLP"
	echo "3. Start QSLP"
	echo "4. Restart QSLP"
	echo "5. Stop QSLP"
	echo "6. PM2 Monitor"
	echo "7. View Status"
	echo "8. Reinstall, Reset Config & Start QSLP"
	echo "9. Exit"
	echo "~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~"
}
# read input from the keyboard and take a action
# invoke the one() when the user select 1 from the menu option.
# invoke the two() when the user select 2 from the menu option.
# Exit when user the user select 3 form the menu option.
read_options(){
	local choice
	read -p "Enter choice [ 1 - 9] " choice
	case $choice in
		1) one ;;
		2) two ;;
                3) three ;;
                4) four ;;
                5) five ;;
                6) six ;;
		7) seven ;;
		8) eight ;;
		9) exit 0;;
		*) echo -e "${RED}Error...${STD}" && sleep 2
	esac
}
 
# ----------------------------------------------
# Step #3: Trap CTRL+C, CTRL+Z and quit singles
# ----------------------------------------------
trap '' SIGINT SIGQUIT SIGTSTP
 
# -----------------------------------
# Step #4: Main logic - infinite loop
# ------------------------------------
while true
do
 
	show_menus
	read_options
done
