FROM node:fermium-buster

# Create app directory
WORKDIR /usr/src/app

# Install app dependencies
#First we Install dependencies, reusing this cache layer if the dependencies didn't change
COPY package*.json ./
RUN npm install

# Copy App Files
COPY . .
#Port defined on server.js
EXPOSE 3001
#Clean Database
RUN npm run seed
CMD [ "npm", "run", "start" ]