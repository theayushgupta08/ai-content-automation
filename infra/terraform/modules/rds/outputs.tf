output "endpoint" {
  value = aws_db_instance.this.address
}

output "port" {
  value = aws_db_instance.this.port
}

output "database_url" {
  description = "Connection string for the api (sslmode=require)."
  value       = "postgresql://avg:${random_password.master.result}@${aws_db_instance.this.address}:${aws_db_instance.this.port}/avg?sslmode=require"
  sensitive   = true
}

output "security_group_id" {
  value = aws_security_group.db.id
}
