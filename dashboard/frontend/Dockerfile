# Build context: dashboard/frontend
FROM nginx:1.27-alpine
COPY public /usr/share/nginx/html
RUN rm /etc/nginx/conf.d/default.conf
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
