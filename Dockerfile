# Cloud Run에서 API 서버를 띄운다. 키는 이미지에 넣지 않고 Secret Manager에서 환경변수로 주입한다.
FROM node:22-slim
WORKDIR /app
COPY . .
ENV NODE_ENV=production
CMD ["npm", "start"]
