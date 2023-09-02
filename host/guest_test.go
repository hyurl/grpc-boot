package host

import (
	"os"
	"testing"
	"time"

	"github.com/ayonli/goext"
	"github.com/ayonli/ngrpc/config"
	"github.com/ayonli/ngrpc/util"
	"github.com/stretchr/testify/assert"
)

func TestNewGuest(t *testing.T) {
	app := config.App{
		Name: "example-server",
		Uri:  "grpc://localhost:4000",
	}
	onStop := func(msgId string) {}
	guest := NewGuest(app, onStop)

	assert.Equal(t, app.Name, guest.AppName)
	assert.Equal(t, app.Uri, guest.AppUri)
	assert.Equal(t, 0, guest.state)
	assert.NotNil(t, guest.handleStopCommand)
}

func TestGuest_JoinAndLeave(t *testing.T) {
	goext.Ok(0, util.CopyFile("../ngrpc.json", "ngrpc.json"))
	goext.Ok(0, util.CopyFile("../tsconfig.json", "tsconfig.json"))
	defer os.Remove("ngrpc.json")
	defer os.Remove("tsconfig.json")

	conf := goext.Ok(config.LoadConfig())
	host := NewHost(conf)
	goext.Ok(0, host.Start(false))
	defer host.Stop()

	c := make(chan string)
	guest := NewGuest(config.App{
		Name: "example-server",
		Uri:  "grpc://localhost:4000",
	}, func(msgId string) {
		c <- msgId
	})
	guest.Join()

	assert.Equal(t, 1, guest.state)
	assert.Equal(t, 1, len(host.clients))

	guest.Leave("app [example-server] stopped", "")

	time.Sleep(time.Second)
	assert.Equal(t, 0, guest.state)
	assert.Equal(t, 0, len(host.clients))
}

func TestGuest_JoinRedundantSocketFile(t *testing.T) {
	sockFile, _ := GetSocketPath()
	os.WriteFile(sockFile, []byte{}, 0644)

	assert.True(t, util.Exists(sockFile))

	c := make(chan string)
	guest := NewGuest(config.App{
		Name: "example-server",
		Uri:  "grpc://localhost:4000",
	}, func(msgId string) {
		c <- msgId
	})
	err := guest.connect()

	assert.NotNil(t, err)
	assert.False(t, util.Exists(sockFile))
}
