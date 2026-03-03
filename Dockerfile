FROM node:22

RUN apt-get update && \
    apt-get install -y python3 python3-pip python3-venv

WORKDIR /app

# 创建 Python 虚拟环境
RUN python3 -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

COPY package*.json ./
RUN npm install

COPY requirements.txt ./
RUN pip install --upgrade pip
RUN pip install -r requirements.txt

COPY . .

EXPOSE 8080

CMD ["node", "server.js"]