// Package db embeds the SQL schema.
package db

import _ "embed"

//go:embed schema.sql
var Schema string
