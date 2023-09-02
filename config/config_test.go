package config

import (
	"net/url"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestLoadConfigFile(t *testing.T) {
	data, err := os.ReadFile("../ngrpc.json")

	if err != nil {
		t.Error(err)
		return
	}

	os.WriteFile("ngrpc.json", data, 0755)

	defer func() {
		os.Remove("ngrpc.json")
	}()

	config, err := LoadConfig()

	if err != nil {
		t.Error(err)
		return
	}

	assert.True(t, len(config.Apps) > 0)
}

func TestLoadLocalConfigFile(t *testing.T) {
	data, err := os.ReadFile("../ngrpc.json")

	if err != nil {
		t.Error(err)
		return
	}

	os.WriteFile("ngrpc.local.json", data, 0755)

	defer func() {
		os.Remove("ngrpc.local.json")
	}()

	config, err := LoadConfig()

	if err != nil {
		t.Error(err)
		return
	}

	assert.True(t, len(config.Apps) > 0)
}

func TestLoadConfigFailure(t *testing.T) {
	cwd, _ := os.Getwd()
	filename := filepath.Join(cwd, "ngrpc.json")
	config, err := LoadConfig()

	assert.Equal(t, Config{Entry: "", Apps: []App(nil)}, config)
	assert.Equal(t, "unable to load config file: "+filename, err.Error())
}

func TestGetAddress(t *testing.T) {
	urlObj1, _ := url.Parse("grpc://localhost:6000")
	urlObj2, _ := url.Parse("grpc://localhost")
	urlObj3, _ := url.Parse("grpcs://localhost")
	urlObj4, _ := url.Parse("grpcs://localhost:6000")
	addr1 := GetAddress(urlObj1)
	addr2 := GetAddress(urlObj2)
	addr3 := GetAddress(urlObj3)
	addr4 := GetAddress(urlObj4)

	assert.Equal(t, "localhost:6000", addr1)
	assert.Equal(t, "localhost:80", addr2)
	assert.Equal(t, "localhost:443", addr3)
	assert.Equal(t, "localhost:6000", addr4)
}

func TestGetCredentials(t *testing.T) {
	app1 := App{
		Name: "test-server",
		Uri:  "grpc://localhost:6000",
	}
	app2 := App{
		Name: "test-server",
		Uri:  "grpcs://localhost:6000",
		Ca:   "../certs/ca.pem",
		Cert: "../certs/cert.pem",
		Key:  "../certs/cert.key",
	}
	urlObj1, _ := url.Parse(app1.Uri)
	urlObj2, _ := url.Parse(app2.Uri)
	cred1, _ := GetCredentials(app1, urlObj1)
	_, err := GetCredentials(app1, urlObj2)
	cred2, _ := GetCredentials(app2, urlObj2)
	cred3, _ := GetCredentials(app2, urlObj1)

	assert.Equal(t, "insecure", cred1.Info().SecurityProtocol)
	assert.Equal(t, "missing 'Ca' config for app [test-server]", err.Error())
	assert.Equal(t, "tls", cred2.Info().SecurityProtocol)
	assert.Equal(t, "tls", cred3.Info().SecurityProtocol)
}

func TestGetCredentialsMissingCaFile(t *testing.T) {
	app := App{
		Name: "server-1",
		Uri:  "grpcs://localhost:6000",
	}

	urlObj, _ := url.Parse(app.Uri)
	_, err := GetCredentials(app, urlObj)

	assert.Equal(t, "missing 'Ca' config for app [server-1]", err.Error())
}

func TestGetCredentialsMissingCertFile(t *testing.T) {
	app := App{
		Name: "server-1",
		Uri:  "grpcs://localhost:6000",
		Ca:   "../certs/ca.pem",
	}

	urlObj, _ := url.Parse(app.Uri)
	_, err := GetCredentials(app, urlObj)

	assert.Equal(t, "missing 'Cert' config for app [server-1]", err.Error())
}

func TestGetCredentialsMissingKeyFile(t *testing.T) {
	app := App{
		Name: "server-1",
		Uri:  "grpcs://localhost:6000",
		Ca:   "../certs/ca.pem",
		Cert: "../certs/cert.pem"}

	urlObj, _ := url.Parse(app.Uri)
	_, err := GetCredentials(app, urlObj)

	assert.Equal(t, "missing 'Key' config for app [server-1]", err.Error())
}

func TestGetCredentialsInvalidCaFile(t *testing.T) {
	app := App{
		Name: "server-1",
		Uri:  "grpcs://localhost:6000",
		Ca:   "./certs/ca.pem",
		Cert: "./certs/cert.pem",
		Key:  "./certs/cert.key",
	}

	urlObj, _ := url.Parse(app.Uri)
	_, err := GetCredentials(app, urlObj)

	assert.Equal(t, "open ./certs/ca.pem: no such file or directory", err.Error())
}

func TestGetCredentialsInvalidCertFile(t *testing.T) {
	app := App{
		Name: "server-1",
		Uri:  "grpcs://localhost:6000",
		Ca:   "../certs/ca.pem",
		Cert: "./certs/cert.pem",
		Key:  "./certs/cert.key",
	}

	urlObj, _ := url.Parse(app.Uri)
	_, err := GetCredentials(app, urlObj)

	assert.Equal(t, "open ./certs/cert.pem: no such file or directory", err.Error())
}

func TestGetCredentialsInvalidKeyFile(t *testing.T) {
	app := App{
		Name: "server-1",
		Uri:  "grpcs://localhost:6000",
		Ca:   "../certs/ca.pem",
		Cert: "../certs/cert.pem",
		Key:  "./certs/cert.key",
	}

	urlObj, _ := url.Parse(app.Uri)
	_, err := GetCredentials(app, urlObj)

	assert.Equal(t, "open ./certs/cert.key: no such file or directory", err.Error())
}

func TestGetCredentialsBadCa(t *testing.T) {
	app := App{
		Name: "server-1",
		Uri:  "grpcs://localhost:6000",
		Ca:   "../certs/ca.srl",
		Cert: "../certs/cert.pem",
		Key:  "../certs/cert.key",
	}

	urlObj, _ := url.Parse(app.Uri)
	_, err := GetCredentials(app, urlObj)

	assert.Equal(t, "unable to create cert pool for CA: ../certs/ca.srl", err.Error())
}
