package main

import (
	"embed"
	"io/fs"
)

//go:embed all:webdist
var embeddedWebFS embed.FS

func embeddedWeb() fs.FS {
	sub, err := fs.Sub(embeddedWebFS, "webdist")
	if err != nil {
		return nil
	}
	return sub
}
