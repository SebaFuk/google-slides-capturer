FROM mcr.microsoft.com/playwright:v1.59.1-jammy

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

ENV NODE_ENV=production
ENV PORT=3030

EXPOSE 3030

CMD ["npm", "start"]
